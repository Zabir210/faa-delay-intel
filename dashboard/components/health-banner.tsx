import type { PipelineHealth } from "@/lib/db/queries";
import { timeAgo } from "@/lib/format";

/**
 * Displaying pipeline health is the point, not decoration: on a calm NAS,
 * `observations` grows by zero rows, so this banner is what proves the
 * cron is actually alive versus silently dead.
 */
export function HealthBanner({ health }: { health: PipelineHealth }) {
  const stale =
    health.minutesSinceLastRun == null || health.minutesSinceLastRun > 20;
  const dotColor = stale
    ? "var(--danger)"
    : health.lastStatus === "ok"
      ? "var(--ok)"
      : "var(--warn)";

  return (
    <div className="card flex flex-wrap items-center gap-x-8 gap-y-2 px-5 py-4 text-sm">
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: dotColor }}
        />
        <span style={{ color: "var(--muted)" }}>
          {stale ? "Pipeline may be stale" : "Pipeline live"} — last run{" "}
          {health.lastRunAt ? timeAgo(health.lastRunAt) : "never"}
        </span>
      </div>
      <div style={{ color: "var(--muted)" }}>
        {health.runsLast24h} successful runs / 24h
      </div>
      <div style={{ color: "var(--muted)" }}>
        {health.observationCount.toLocaleString()} observations
      </div>
      <div style={{ color: "var(--muted)" }}>
        {health.eventCount.toLocaleString()} events
      </div>
      {health.oldestObservationAt && (
        <div style={{ color: "var(--muted)" }}>
          collecting since{" "}
          {new Date(health.oldestObservationAt).toLocaleDateString()}
        </div>
      )}
    </div>
  );
}
