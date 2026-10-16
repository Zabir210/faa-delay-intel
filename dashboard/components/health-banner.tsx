import type { HourlyRuns, PipelineHealth } from "@/lib/db/queries";
import { timeAgo } from "@/lib/format";

/**
 * Displaying pipeline health is the point, not decoration: on a calm NAS,
 * `observations` grows by zero rows, so this is what proves the cron is
 * actually alive versus silently dead.
 */
export function pipelineState(health: PipelineHealth) {
  const stale = health.minutesSinceLastRun == null || health.minutesSinceLastRun > 20;
  if (stale) return { tone: "critical", label: "Pipeline stale" } as const;
  if (health.lastStatus !== "ok") return { tone: "warning", label: "Last run failed" } as const;
  return { tone: "good", label: "Live" } as const;
}

/** Header pill: status icon + label + last-run age (never color alone). */
export function StatusPill({ health }: { health: PipelineHealth }) {
  const s = pipelineState(health);
  return (
    <div
      className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium"
      style={{ background: "var(--card)", border: "1px solid var(--border)" }}
    >
      <span
        className={`inline-block h-2 w-2 rounded-full ${s.tone === "good" ? "live-dot" : ""}`}
        style={{ background: `var(--${s.tone})` }}
        aria-hidden
      />
      <span>{s.label}</span>
      <span className="text-muted">
        · updated {health.lastRunAt ? timeAgo(health.lastRunAt) : "never"}
      </span>
    </div>
  );
}

/** 24 hourly columns of ingest runs (12/hour = every 5 min, on schedule). */
export function PipelineCard({
  health,
  hourly,
}: {
  health: PipelineHealth;
  hourly: HourlyRuns[];
}) {
  const expected = 12;
  const ok = hourly.reduce((s, h) => s + h.ok, 0);
  // The current hour is still filling; judge uptime on completed hours.
  const done = hourly.slice(0, -1);
  const pct = done.length
    ? Math.round((done.reduce((s, h) => s + Math.min(h.ok, expected), 0) / (done.length * expected)) * 1000) / 10
    : 0;

  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="eyebrow">Ingest pipeline · last 24h</h2>
        <span className="text-xs text-muted tnum">{ok} ok runs</span>
      </div>
      <div className="mt-2 text-2xl font-semibold">{pct}%</div>
      <div className="text-xs text-secondary">of scheduled 5-minute runs completed</div>

      <div className="mt-4 flex h-10 items-end gap-[2px]" role="img"
        aria-label={`Hourly ingest runs, last 24 hours: ${hourly.map((h) => h.ok).join(", ")}`}>
        {hourly.map((h, i) => {
          const last = i === hourly.length - 1;
          const full = h.ok >= expected;
          const height = Math.max(3, (Math.min(h.ok, expected) / expected) * 40);
          return (
            <div
              key={String(h.hour)}
              title={`${new Date(h.hour).toLocaleTimeString("en-US", { hour: "numeric", timeZone: "UTC" })} UTC: ${h.ok}/${expected} runs${last ? " (hour in progress)" : ""}`}
              className="flex-1 rounded-t-[3px]"
              style={{
                height,
                background: last || full ? "var(--good)" : h.ok === 0 ? "var(--critical)" : "var(--warning)",
                opacity: last ? 0.45 : 1,
              }}
            />
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-muted">
        <span>24h ago</span>
        <span>now</span>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 border-t pt-4 text-xs" style={{ borderColor: "var(--border)" }}>
        <div>
          <dt className="text-muted">Observations</dt>
          <dd className="mt-0.5 text-sm font-semibold tnum">{health.observationCount.toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-muted">Collecting since</dt>
          <dd className="mt-0.5 text-sm font-semibold">
            {health.oldestObservationAt ? new Date(health.oldestObservationAt).toISOString().slice(0, 10) : "–"}
          </dd>
        </div>
      </dl>
    </div>
  );
}
