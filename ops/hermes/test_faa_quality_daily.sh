#!/usr/bin/env bash
# Scenario test for faa_quality_daily.sh with a fake gh (no network).
#   bash ops/hermes/test_faa_quality_daily.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0

# Fake gh driven by env: DISPATCH=ok|url|err, STATES="queued in_progress completed\ success"
cat > "$T/gh" <<'EOF'
#!/usr/bin/env bash
case "$1 $2" in
  "workflow run")
    case "$DISPATCH" in
      err) echo "HTTP 403: account is locked due to a billing issue" >&2; exit 1 ;;
      url) echo "https://github.com/Zabir210/faa-delay-intel/actions/runs/111" ;;
      *)   echo "✓ Created workflow_dispatch event for quality.yml at main" ;;
    esac ;;
  "run list") echo 222 ;;
  "run view")
    if [[ " $* " == *" --log-failed "* ]]; then
      printf 'quality\tRun\t2026-10-13T14:00:00.0Z FAILED tests/test_data_quality.py::test_ingest_runs_mostly_ok\n'
      printf 'quality\tRun\t2026-10-13T14:00:00.0Z E   AssertionError: 200/288 runs ok (69.4%%) in last 1 day\n'
      exit 0
    fi
    n=$(cat "$CALLS" 2>/dev/null || echo 0); echo $((n + 1)) > "$CALLS"
    IFS='|' read -ra S <<< "$STATES"; i=$(( n < ${#S[@]} ? n : ${#S[@]} - 1 ))
    echo "${S[$i]}" ;;
esac
EOF
chmod +x "$T/gh"

check() {  # name expect(regex|EMPTY) env...
  local name=$1 want=$2; shift 2
  rm -f "$T/calls"
  local out; out="$(env GH="$T/gh" CALLS="$T/calls" POLL_S=0 MAX_WAIT_S=2 "$@" bash "$HERE/faa_quality_daily.sh")"
  if { [ "$want" = EMPTY ] && [ -z "$out" ]; } || { [ "$want" != EMPTY ] && [[ "$out" =~ $want ]]; }; then
    echo "ok   - $name"
  else
    echo "FAIL - $name: got [$out] want [$want]"; fail=1
  fi
}

check "success is silent"            EMPTY  DISPATCH=url STATES="queued |in_progress |completed success"
check "run id found via run list"    EMPTY  DISPATCH=ok  STATES="completed success"
check "failure names the check"      "run failure — .*test_ingest_runs_mostly_ok" \
                                            DISPATCH=url STATES="in_progress |completed failure"
check "failure shows the assertion"  "AssertionError: 200/288 runs ok \(69.4%\).*runs/111" \
                                            DISPATCH=url STATES="completed failure"
check "cancelled run alerts"         "run cancelled" DISPATCH=url STATES="completed cancelled"
check "dispatch error alerts"        "could not dispatch.*billing" DISPATCH=err STATES=""
check "stuck run alerts"             "did not finish within 0s.*runs/111" \
                                            DISPATCH=url STATES="queued " MAX_WAIT_S=0
exit $fail
