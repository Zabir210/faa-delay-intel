import Link from "next/link";

import {
  getCurrentDisruptions,
  getDailyActivity,
  getHourlyRuns,
  getPipelineHealth,
  getWorstAirports,
  type CurrentDisruption,
  type WorstAirport,
} from "@/lib/db/queries";
import { TYPE_LABEL, type DelayType } from "@/lib/delay-types";
import { ActivityChart } from "@/components/activity-chart";
import { PipelineCard, StatusPill } from "@/components/health-banner";
import { formatMinutes, timeAgo } from "@/lib/format";

export const dynamic = "force-dynamic"; // always live data, never a stale build snapshot

export default async function HomePage() {
  const [health, disruptions, worst, activity, hourly] = await Promise.all([
    getPipelineHealth(),
    getCurrentDisruptions(),
    getWorstAirports(30),
    getDailyActivity(30),
    getHourlyRuns(),
  ]);

  const delays = disruptions.filter((d) => d.delayType !== "closure");
  const closures = disruptions.filter((d) => d.delayType === "closure");
  const airports = new Set(disruptions.map((d) => d.airport)).size;
  const longest = delays.reduce<CurrentDisruption | null>(
    (best, d) => ((d.peakDelayMinutes ?? 0) > (best?.peakDelayMinutes ?? -1) ? d : best),
    null
  );
  const events30 = worst.reduce((s, w) => s + w.eventCount, 0);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="eyebrow mb-2">US National Airspace System</p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            FAA Delay Intelligence
          </h1>
          <p className="mt-2 max-w-xl text-sm text-secondary">
            Live airport disruptions from the FAA NAS Status feed, polled every
            5 minutes and kept as history the FAA doesn&rsquo;t publish.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <StatusPill health={health} />
          <a href="https://github.com/Zabir210/faa-delay-intel" className="link text-xs">
            Source ↗
          </a>
        </div>
      </header>

      <section className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Key figures">
        <Stat label="Active disruptions" value={disruptions.length.toString()} hero
          sub={`${delays.length} delays · ${closures.length} closures`} />
        <Stat label="Airports affected" value={airports.toString()} sub="with an open event now" />
        <Stat label="Longest current delay" value={formatMinutes(longest?.peakDelayMinutes ?? null)}
          sub={longest ? `${longest.airport} · ${TYPE_LABEL[longest.delayType as DelayType] ?? longest.delayType}` : "no active delays"} />
        <Stat label="Events, last 30 days" value={events30.toLocaleString()}
          sub={`${health.eventCount.toLocaleString()} recorded all-time`} />
      </section>

      <section className="card mt-4 p-5 sm:p-6">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold">Disruption activity</h2>
            <p className="text-xs text-secondary">New delay events per day, last 30 days (UTC)</p>
          </div>
        </div>
        <ActivityChart data={activity} />
      </section>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <section className="lg:col-span-2">
          <div className="card p-5 sm:p-6">
            <div className="mb-4 flex items-baseline justify-between">
              <h2 className="text-base font-semibold">Happening now</h2>
              <span className="text-xs text-muted">{disruptions.length} open events</span>
            </div>
            {disruptions.length === 0 ? (
              <p className="py-6 text-sm text-secondary">
                No open disruptions right now. The National Airspace System is
                calm, and the pipeline status above confirms this is real, not
                missing data.
              </p>
            ) : (
              <>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {delays.map((d, i) => (
                    <DisruptionCard key={`${d.airport}-${d.delayType}-${d.direction ?? ""}-${i}`} d={d} />
                  ))}
                </ul>
                {closures.length > 0 && (
                  <>
                    <h3 className="eyebrow mb-2 mt-5">Closures &amp; NOTAMs</h3>
                    <ul className="divide-y" style={{ borderColor: "var(--border)" }}>
                      {closures.map((d, i) => (
                        <li key={`${d.airport}-${i}`} className="flex gap-3 py-2.5 text-sm"
                          style={{ borderColor: "var(--border)" }}>
                          <Link href={`/airports/${d.airport}`} className="link w-12 shrink-0 font-semibold">
                            {d.airport}
                          </Link>
                          <span className="line-clamp-2 flex-1 text-xs text-secondary mono" title={d.reason ?? ""}>
                            {d.reason ?? "Closed"}
                          </span>
                          <span className="shrink-0 text-xs text-muted tnum">{timeAgo(d.startedAt)}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
          </div>
        </section>

        <aside className="flex flex-col gap-4">
          <WorstAirports worst={worst.slice(0, 8)} />
          <PipelineCard health={health} hourly={hourly} />
        </aside>
      </div>

      <footer className="mt-10 text-xs text-muted">
        Data: FAA NAS Status (nasstatus.faa.gov). Built by Zabir Islam.
      </footer>
    </main>
  );
}

function Stat({ label, value, sub, hero }: { label: string; value: string; sub: string; hero?: boolean }) {
  return (
    <div className="card p-4 sm:p-5">
      <div className="eyebrow">{label}</div>
      <div className={`mt-1.5 font-semibold tracking-tight ${hero ? "text-5xl" : "text-3xl"}`}>{value}</div>
      <div className="mt-1 truncate text-xs text-secondary">{sub}</div>
    </div>
  );
}

function DisruptionCard({ d }: { d: CurrentDisruption }) {
  const type = d.delayType as DelayType;
  return (
    <li>
      <Link href={`/airports/${d.airport}`}
        className="group flex h-full gap-3 rounded-xl p-3.5 transition-colors hover:bg-[var(--card-hover)]"
        style={{ border: "1px solid var(--border)" }}>
        <span className="mt-1 w-1 shrink-0 self-stretch rounded-full" style={{ background: `var(--s-${type})` }} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-lg font-semibold tracking-tight">{d.airport}</span>
            <span className="text-lg font-semibold tnum">{formatMinutes(d.peakDelayMinutes)}</span>
          </div>
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="text-secondary">
              {TYPE_LABEL[type] ?? d.delayType}
              {d.direction ? ` · ${d.direction}` : ""}
            </span>
            <span className="text-muted">peak</span>
          </div>
          <div className="mt-2 flex items-baseline justify-between gap-2 text-xs">
            <span className="truncate text-secondary first-letter:uppercase">{d.reason ?? "No reason given"}</span>
            <span className="shrink-0 text-muted">since {timeAgo(d.startedAt).replace(" ago", "")}</span>
          </div>
        </div>
      </Link>
    </li>
  );
}

function WorstAirports({ worst }: { worst: WorstAirport[] }) {
  const max = Math.max(1, ...worst.map((w) => w.totalDelayMinutes));
  return (
    <div className="card p-5">
      <div className="mb-1 flex items-baseline justify-between">
        <h2 className="text-base font-semibold">Most disrupted</h2>
        <span className="text-xs text-muted">30 days</span>
      </div>
      <p className="mb-4 text-xs text-secondary">Sum of peak delay across events</p>
      {worst.length === 0 ? (
        <p className="text-sm text-secondary">Not enough history yet.</p>
      ) : (
        <ol className="space-y-2.5">
          {worst.map((w) => (
            <li key={w.airport}>
              <Link href={`/airports/${w.airport}`} className="group grid grid-cols-[2.75rem_1fr_auto] items-center gap-2 text-sm"
                title={`${w.airport}: ${formatMinutes(w.totalDelayMinutes)} total over ${w.eventCount} events; worst single ${formatMinutes(w.maxDelayMinutes)}`}>
                <span className="font-semibold group-hover:underline">{w.airport}</span>
                <span className="relative h-2.5 rounded-full" style={{ background: "var(--grid)" }}>
                  <span className="absolute inset-y-0 left-0 rounded-full transition-opacity group-hover:opacity-80"
                    style={{ width: `${Math.max(3, (w.totalDelayMinutes / max) * 100)}%`, background: "var(--bar)" }} />
                </span>
                <span className="w-14 text-right text-xs text-secondary tnum">{formatMinutes(w.totalDelayMinutes)}</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
