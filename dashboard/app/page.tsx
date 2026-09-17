import Link from "next/link";

import {
  getCurrentDisruptions,
  getPipelineHealth,
  getWorstAirports,
} from "@/lib/db/queries";
import { HealthBanner } from "@/components/health-banner";
import { formatMinutes, timeAgo } from "@/lib/format";

export const dynamic = "force-dynamic"; // always live data, never a stale build snapshot

export default async function HomePage() {
  const [health, disruptions, worst] = await Promise.all([
    getPipelineHealth(),
    getCurrentDisruptions(),
    getWorstAirports(30),
  ]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          FAA Delay Intelligence
        </h1>
        <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
          Live US airport disruption tracking, polled from the FAA NAS
          Status feed every 5 minutes.{" "}
          <a
            href="https://github.com/Zabir210/faa-delay-intel"
            className="underline"
            style={{ color: "var(--accent)" }}
          >
            Source
          </a>
        </p>
      </header>

      <HealthBanner health={health} />

      <section className="mt-8">
        <h2
          className="mb-3 text-sm font-medium uppercase tracking-wide"
          style={{ color: "var(--muted)" }}
        >
          Currently disrupted ({disruptions.length})
        </h2>
        {disruptions.length === 0 ? (
          <p className="card p-6 text-sm" style={{ color: "var(--muted)" }}>
            No open disruptions right now — the National Airspace System is
            calm. That&rsquo;s a real, verified state, not missing data (see
            pipeline health above).
          </p>
        ) : (
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="border-b text-left"
                  style={{ borderColor: "var(--border)" }}
                >
                  <th className="px-4 py-3 font-medium">Airport</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Reason</th>
                  <th className="px-4 py-3 font-medium text-right">Peak</th>
                  <th className="px-4 py-3 font-medium text-right">Started</th>
                </tr>
              </thead>
              <tbody>
                {disruptions.map((d, i) => (
                  <tr
                    key={`${d.airport}-${d.delayType}-${d.direction ?? ""}-${i}`}
                    className="border-b last:border-0"
                    style={{ borderColor: "var(--border)" }}
                  >
                    <td className="px-4 py-3 font-medium">
                      <Link
                        href={`/airports/${d.airport}`}
                        className="underline"
                        style={{ color: "var(--accent)" }}
                      >
                        {d.airport}
                      </Link>
                      {d.direction && (
                        <span
                          className="ml-1 text-xs"
                          style={{ color: "var(--muted)" }}
                        >
                          {d.direction}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 capitalize">
                      {d.delayType.replace("_", " ")}
                    </td>
                    <td className="px-4 py-3" style={{ color: "var(--muted)" }}>
                      {d.reason ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right mono">
                      {formatMinutes(d.peakDelayMinutes)}
                    </td>
                    <td
                      className="px-4 py-3 text-right mono"
                      style={{ color: "var(--muted)" }}
                    >
                      {timeAgo(d.startedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-10">
        <h2
          className="mb-3 text-sm font-medium uppercase tracking-wide"
          style={{ color: "var(--muted)" }}
        >
          Worst airports — last 30 days
        </h2>
        {worst.length === 0 ? (
          <p className="card p-6 text-sm" style={{ color: "var(--muted)" }}>
            Not enough history yet to rank airports. Check back after a few
            days of data collection.
          </p>
        ) : (
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="border-b text-left"
                  style={{ borderColor: "var(--border)" }}
                >
                  <th className="px-4 py-3 font-medium">#</th>
                  <th className="px-4 py-3 font-medium">Airport</th>
                  <th className="px-4 py-3 font-medium text-right">Events</th>
                  <th className="px-4 py-3 font-medium text-right">
                    Total delay
                  </th>
                  <th className="px-4 py-3 font-medium text-right">
                    Worst single
                  </th>
                </tr>
              </thead>
              <tbody>
                {worst.map((w, i) => (
                  <tr
                    key={w.airport}
                    className="border-b last:border-0"
                    style={{ borderColor: "var(--border)" }}
                  >
                    <td className="px-4 py-3" style={{ color: "var(--muted)" }}>
                      {i + 1}
                    </td>
                    <td className="px-4 py-3 font-medium">
                      <Link
                        href={`/airports/${w.airport}`}
                        className="underline"
                        style={{ color: "var(--accent)" }}
                      >
                        {w.airport}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-right mono">{w.eventCount}</td>
                    <td className="px-4 py-3 text-right mono">
                      {formatMinutes(w.totalDelayMinutes)}
                    </td>
                    <td className="px-4 py-3 text-right mono">
                      {formatMinutes(w.maxDelayMinutes)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
