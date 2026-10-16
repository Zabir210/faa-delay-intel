import Link from "next/link";
import { notFound } from "next/navigation";

import { AirportTimeline } from "@/components/airport-timeline";
import {
  getAirportEvents,
  getAirportHistory,
  getAirportSummary,
  getAirportTimeline,
  type AirportEvent,
} from "@/lib/db/queries";
import { TYPE_LABEL, type DelayType } from "@/lib/delay-types";
import { formatMinutes, timeAgo } from "@/lib/format";

export const dynamic = "force-dynamic";

const AIRPORT_CODE_RE = /^[A-Z0-9]{3,4}$/;
const RANGES = [7, 30] as const;

export default async function AirportPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { code } = await params;
  const airport = code.toUpperCase();
  if (!AIRPORT_CODE_RE.test(airport)) notFound();
  const days = (await searchParams).days === "30" ? 30 : 7;

  const [summary, events, timeline, history] = await Promise.all([
    getAirportSummary(airport, 30),
    getAirportEvents(airport, 25),
    getAirportTimeline(airport, days),
    getAirportHistory(airport, 7),
  ]);
  const open = events.filter((e) => e.endedAt == null);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <Link href="/" className="link text-sm">&larr; All airports</Link>

      <header className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="eyebrow mb-2">Airport</p>
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">{airport}</h1>
          <p className="mt-2 text-sm text-secondary">
            {summary.lastEventAt
              ? `Last disruption started ${timeAgo(summary.lastEventAt)}.`
              : "No disruptions recorded for this airport yet."}
          </p>
        </div>
        <StatusBadge open={open} />
      </header>

      <section className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Key figures">
        <Stat label="Open now" value={open.length.toString()} hero
          sub={open.length ? open.map((e) => label(e.delayType)).join(" · ") : "no active disruption"} />
        <Stat label="Events, last 30 days" value={summary.eventCount.toLocaleString()}
          sub="started in the last 30 days" />
        <Stat label="Worst single delay" value={formatMinutes(summary.worst?.minutes ?? null)}
          sub={summary.worst ? `${label(summary.worst.delayType)} · ${shortDate(summary.worst.startedAt)}` : "none in 30 days"} />
        <Stat label="Total delay, 30 days" value={formatMinutes(summary.totalDelayMinutes || null)}
          sub="sum of peak delay per event" />
      </section>

      <section className="card mt-4 p-5 sm:p-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Delay timeline</h2>
            <p className="text-xs text-secondary">
              Worst reported delay per {timeline.bucketMinutes === 30 ? "30 minutes" : "2 hours"}, last {days} days (UTC)
            </p>
          </div>
          <nav className="flex rounded-lg p-0.5 text-xs" style={{ border: "1px solid var(--border)" }} aria-label="Time range">
            {RANGES.map((r) => (
              <Link key={r} href={r === 7 ? `/airports/${airport}` : `/airports/${airport}?days=${r}`}
                scroll={false} aria-current={r === days ? "page" : undefined}
                className="rounded-md px-2.5 py-1 font-medium"
                style={r === days ? { background: "var(--card-hover)", color: "var(--foreground)" } : { color: "var(--muted)" }}>
                {r}d
              </Link>
            ))}
          </nav>
        </div>
        <AirportTimeline data={timeline} />
      </section>

      <section className="card mt-4 p-5 sm:p-6">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-base font-semibold">Recent events</h2>
          <span className="text-xs text-muted">latest {events.length}</span>
        </div>
        {events.length === 0 ? (
          <p className="py-4 text-sm text-secondary">No delay events recorded for {airport}.</p>
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--border)" }}>
            {events.map((e) => <EventRow key={e.id} e={e} />)}
          </ul>
        )}
      </section>

      <details className="card mt-4 p-5 sm:p-6">
        <summary className="cursor-pointer select-none text-base font-semibold">
          Raw observations <span className="text-xs font-normal text-muted">· last 7 days, {history.length}{history.length >= 500 ? "+" : ""} rows</span>
        </summary>
        {history.length === 0 ? (
          <p className="mt-4 text-sm text-secondary">No observations for {airport} in the last 7 days.</p>
        ) : (
          <div className="mt-4 max-h-[32rem] overflow-auto">
            <table className="w-full text-sm tnum">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="py-2 pr-4 font-medium">When</th>
                  <th className="py-2 pr-4 font-medium">Type</th>
                  <th className="py-2 pr-4 font-medium">Direction</th>
                  <th className="py-2 pr-4 text-right font-medium">Min</th>
                  <th className="py-2 pr-4 text-right font-medium">Max</th>
                  <th className="py-2 font-medium">Trend</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={`${h.updateTime}-${i}`} style={{ borderTop: "1px solid var(--border)" }}>
                    <td className="whitespace-nowrap py-2 pr-4 text-secondary" title={new Date(h.updateTime).toISOString()}>
                      {timeAgo(h.updateTime)}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-4">{label(h.delayType)}</td>
                    <td className="py-2 pr-4 text-secondary">{h.direction ?? "—"}</td>
                    <td className="py-2 pr-4 text-right">{formatMinutes(h.minDelayMinutes)}</td>
                    <td className="py-2 pr-4 text-right">{formatMinutes(h.maxDelayMinutes)}</td>
                    <td className={h.trend === "Increasing" ? "py-2 trend-up" : h.trend === "Decreasing" ? "py-2 trend-down" : "py-2 text-muted"}>
                      {h.trend ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>

      <footer className="mt-10 text-xs text-muted">
        Data: FAA NAS Status (nasstatus.faa.gov). Times in UTC.
      </footer>
    </main>
  );
}

function StatusBadge({ open }: { open: AirportEvent[] }) {
  const disrupted = open.length > 0;
  return (
    <div className="inline-flex items-center gap-2 self-start rounded-full px-3 py-1.5 text-sm font-medium sm:self-auto"
      style={{ border: "1px solid var(--border)", background: "var(--card)" }}>
      <span className={`inline-block h-2 w-2 rounded-full ${disrupted ? "" : "live-dot"}`} aria-hidden
        style={{ background: disrupted ? "var(--critical)" : "var(--good)" }} />
      {disrupted ? `Disrupted · ${open.length} open event${open.length > 1 ? "s" : ""}` : "Operating normally"}
    </div>
  );
}

function Stat({ label, value, sub, hero }: { label: string; value: string; sub: string; hero?: boolean }) {
  return (
    <div className="card min-w-0 p-4 sm:p-5">
      <div className="eyebrow">{label}</div>
      <div className={`mt-1.5 font-semibold tracking-tight ${hero ? "text-5xl" : "text-3xl"}`}>{value}</div>
      <div className="mt-1 line-clamp-2 text-xs text-secondary" title={sub}>{sub}</div>
    </div>
  );
}

function EventRow({ e }: { e: AirportEvent }) {
  const type = e.delayType as DelayType;
  const duration = Math.max(0, e.durationMinutes);
  return (
    <li className="flex gap-3 py-3" style={{ borderColor: "var(--border)" }}>
      <span className="w-1 shrink-0 self-stretch rounded-full" style={{ background: `var(--s-${type})` }} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm font-medium">
            {label(e.delayType)}
            {e.direction && <span className="text-xs font-normal text-secondary">{e.direction}</span>}
            {e.endedAt == null && <Tag tone="critical">Open</Tag>}
            {e.isAnomaly && <Tag tone="warning">Anomaly</Tag>}
          </span>
          <span className="shrink-0 text-sm font-semibold tnum">
            {e.peakDelayMinutes != null ? formatMinutes(e.peakDelayMinutes) : ""}
          </span>
        </div>
        <div className="mt-0.5 flex items-baseline justify-between gap-3 text-xs">
          <span className="truncate text-secondary first-letter:uppercase" title={e.reason ?? ""}>
            {e.reason ?? "No reason given"}
          </span>
          <span className="shrink-0 text-muted tnum">
            {shortDate(e.startedAt)} · {e.endedAt ? formatDuration(duration) : `${formatDuration(duration)} so far`}
          </span>
        </div>
      </div>
    </li>
  );
}

function Tag({ tone, children }: { tone: "critical" | "warning"; children: React.ReactNode }) {
  return (
    <span className="rounded-full px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide"
      style={{ border: `1px solid var(--${tone})`, color: tone === "critical" ? "var(--critical-ink)" : "var(--secondary)" }}>
      {children}
    </span>
  );
}

function label(type: string) {
  return TYPE_LABEL[type as DelayType] ?? type;
}

/** Event length; multi-day closures read as days, not "180h". */
function formatDuration(minutes: number) {
  if (minutes < 48 * 60) return formatMinutes(minutes);
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  return h ? `${d}d ${h}h` : `${d}d`;
}

function shortDate(iso: string) {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} ${d.toISOString().slice(11, 16)}`;
}
