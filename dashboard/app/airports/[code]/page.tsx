import Link from "next/link";
import { notFound } from "next/navigation";

import { getAirportHistory } from "@/lib/db/queries";
import { formatMinutes, timeAgo } from "@/lib/format";

export const dynamic = "force-dynamic";

const AIRPORT_CODE_RE = /^[A-Z0-9]{3,4}$/;

export default async function AirportHistoryPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const airport = code.toUpperCase();
  if (!AIRPORT_CODE_RE.test(airport)) notFound();

  const history = await getAirportHistory(airport, 7);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <Link
        href="/"
        className="text-sm underline"
        style={{ color: "var(--accent)" }}
      >
        &larr; back
      </Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">
        {airport}
      </h1>
      <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
        Raw observations, last 7 days, most recent first.
      </p>

      {history.length === 0 ? (
        <p className="card mt-6 p-6 text-sm" style={{ color: "var(--muted)" }}>
          No disruptions recorded for {airport} in the last 7 days.
        </p>
      ) : (
        <div className="card mt-6 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr
                className="border-b text-left"
                style={{ borderColor: "var(--border)" }}
              >
                <th className="px-4 py-3 font-medium">When</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Direction</th>
                <th className="px-4 py-3 font-medium text-right">Min</th>
                <th className="px-4 py-3 font-medium text-right">Max</th>
                <th className="px-4 py-3 font-medium">Trend</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h, i) => (
                <tr
                  key={`${h.updateTime}-${i}`}
                  className="border-b last:border-0"
                  style={{ borderColor: "var(--border)" }}
                >
                  <td className="px-4 py-3 mono" style={{ color: "var(--muted)" }}>
                    {timeAgo(h.updateTime)}
                  </td>
                  <td className="px-4 py-3 capitalize">
                    {h.delayType.replace("_", " ")}
                  </td>
                  <td className="px-4 py-3" style={{ color: "var(--muted)" }}>
                    {h.direction ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right mono">
                    {formatMinutes(h.minDelayMinutes)}
                  </td>
                  <td className="px-4 py-3 text-right mono">
                    {formatMinutes(h.maxDelayMinutes)}
                  </td>
                  <td
                    className={
                      h.trend === "Increasing"
                        ? "px-4 py-3 trend-up"
                        : h.trend === "Decreasing"
                          ? "px-4 py-3 trend-down"
                          : "px-4 py-3"
                    }
                    style={h.trend ? undefined : { color: "var(--muted)" }}
                  >
                    {h.trend ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
