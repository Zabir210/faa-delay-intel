"use client";

import { useLayoutEffect, useRef, useState } from "react";

import { formatMinutes } from "@/lib/format";
import {
  MINUTE_TYPES,
  SPAN_TYPES,
  TYPE_LABEL,
  type AirportTimeline as Timeline,
} from "@/lib/delay-types";

const PLOT_H = 190;
const LANE_H = 12;
const LANE_GAP = 8;
const PAD = { top: 12, right: 10, bottom: 26, left: 56 };
const H = PAD.top + PLOT_H + 14 + SPAN_TYPES.length * (LANE_H + LANE_GAP) + PAD.bottom;
const HATCH = "repeating-linear-gradient(45deg, var(--nodata-ink) 0 2px, var(--nodata) 2px 5px)";

/** Worst reported delay per time bucket for minute-bearing types (lines),
 * with ground stops and closures as on/off lanes underneath. One crosshair
 * reads every series at the hovered time. */
export function AirportTimeline({ data }: { data: Timeline }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(260, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = data.buckets.length;
  const allMinutes = MINUTE_TYPES.flatMap((t) => data.minutes[t]).filter((v): v is number => v != null);
  const max = niceMax(Math.max(0, ...allMinutes));
  const ticks = [0, max / 2, max];
  const innerW = width - PAD.left - PAD.right;
  const step = innerW / Math.max(1, n);
  const x = (i: number) => PAD.left + step * i + step / 2;
  const y = (v: number) => PAD.top + PLOT_H - (v / max) * PLOT_H;
  const laneTop = (k: number) => PAD.top + PLOT_H + 14 + k * (LANE_H + LANE_GAP);
  const bottom = laneTop(SPAN_TYPES.length) - LANE_GAP;
  const empty =
    allMinutes.length === 0 && SPAN_TYPES.every((t) => !data.active[t].some(Boolean));

  const dayTicks = dayBoundaries(data.buckets);
  const labelEvery = Math.max(1, Math.ceil(dayTicks.length / Math.max(2, Math.floor(innerW / 56))));

  function indexAt(clientX: number) {
    const rect = wrap.current?.getBoundingClientRect();
    if (!rect) return null;
    const i = Math.floor((clientX - rect.left - PAD.left) / step);
    return i < 0 || i >= n ? null : i;
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setHover((h) => {
      const cur = h ?? n - 1;
      return Math.min(n - 1, Math.max(0, cur + (e.key === "ArrowLeft" ? -1 : 1)));
    });
  }

  return (
    <div>
      <ul className="mb-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-secondary">
        {MINUTE_TYPES.map((t) => (
          <li key={t} className="flex items-center gap-1.5">
            <span className="inline-block h-[2px] w-3.5 rounded-full" style={{ background: `var(--s-${t})` }} />
            {TYPE_LABEL[t]}
          </li>
        ))}
        {SPAN_TYPES.map((t) => (
          <li key={t} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: `var(--s-${t})` }} />
            {TYPE_LABEL[t]}
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ backgroundImage: HATCH }} />
          Pipeline offline
        </li>
      </ul>

      <div
        ref={wrap}
        className="relative touch-pan-y outline-none"
        tabIndex={0}
        role="group"
        aria-label="Delay timeline. Use the left and right arrow keys to read values."
        onPointerMove={(e) => setHover(indexAt(e.clientX))}
        onPointerDown={(e) => setHover(indexAt(e.clientX))}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        <svg width={width} height={H} role="img" aria-label="Worst reported delay over time, by delay type">
          <defs>
            <pattern id="tl-nodata" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="5" height="5" fill="var(--nodata)" />
              <rect width="2" height="5" fill="var(--nodata-ink)" />
            </pattern>
          </defs>

          {runs(data.offline).map(([a, b]) => (
            <rect key={`off-${a}`} x={PAD.left + step * a} y={PAD.top} width={step * (b - a + 1)}
              height={bottom - PAD.top} fill="url(#tl-nodata)" />
          ))}

          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)}
                stroke={t === 0 ? "var(--baseline)" : "var(--grid)"} strokeWidth={1} />
              <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--muted)" className="tnum">
                {t === 0 ? "0" : formatMinutes(t)}
              </text>
            </g>
          ))}

          {MINUTE_TYPES.map((t) =>
            runs(data.minutes[t].map((v) => v != null)).map(([a, b]) =>
              a === b ? (
                <circle key={`${t}-${a}`} cx={x(a)} cy={y(data.minutes[t][a]!)} r={3}
                  fill={`var(--s-${t})`} stroke="var(--card)" strokeWidth={2} />
              ) : (
                <path key={`${t}-${a}`} fill="none" stroke={`var(--s-${t})`} strokeWidth={2}
                  strokeLinejoin="round" strokeLinecap="round"
                  d={Array.from({ length: b - a + 1 }, (_, k) => `${k ? "L" : "M"}${x(a + k)},${y(data.minutes[t][a + k]!)}`).join("")} />
              )
            )
          )}

          {SPAN_TYPES.map((t, k) => (
            <g key={t}>
              <text x={PAD.left - 8} y={laneTop(k) + LANE_H / 2} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--muted)">
                {t === "ground_stop" ? "Stop" : "Closure"}
              </text>
              <rect x={PAD.left} y={laneTop(k)} width={innerW} height={LANE_H} rx={3} fill="var(--grid)" opacity={0.5} />
              {runs(data.active[t]).map(([a, b]) => (
                <rect key={a} x={PAD.left + step * a} y={laneTop(k)} rx={3}
                  width={Math.max(3, step * (b - a + 1) - 1)} height={LANE_H} fill={`var(--s-${t})`} />
              ))}
            </g>
          ))}

          {dayTicks.map(({ i, label }, k) =>
            k % labelEvery === 0 ? (
              <g key={i}>
                <line x1={PAD.left + step * i} x2={PAD.left + step * i} y1={bottom} y2={bottom + 4} stroke="var(--baseline)" />
                <text x={PAD.left + step * i} y={H - 8} textAnchor={PAD.left + step * i > width - 40 ? "end" : "middle"}
                  fontSize={11} fill="var(--muted)">{label}</text>
              </g>
            ) : null
          )}

          {empty && (
            <text x={PAD.left + innerW / 2} y={PAD.top + PLOT_H / 2} textAnchor="middle" fontSize={13} fill="var(--secondary)">
              No disruptions reported in this window
            </text>
          )}

          {hover != null && (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={bottom} stroke="var(--secondary)" strokeWidth={1} />
              {MINUTE_TYPES.map((t) => {
                const v = data.minutes[t][hover];
                return v == null ? null : (
                  <circle key={t} cx={x(hover)} cy={y(v)} r={4} fill={`var(--s-${t})`} stroke="var(--card)" strokeWidth={2} />
                );
              })}
            </g>
          )}
        </svg>

        {hover != null && (
          <Tooltip x={x(hover)} width={width}>
            <div className="mb-1.5 text-xs text-secondary">
              {bucketLabel(data.buckets[hover], data.bucketMinutes)}
            </div>
            {data.offline[hover] ? (
              <div className="text-sm text-secondary">No data: ingest pipeline was offline</div>
            ) : (
              <>
                {MINUTE_TYPES.map((t) => (
                  <Row key={t} type={t} value={formatMinutes(data.minutes[t][hover])} />
                ))}
                {SPAN_TYPES.map((t) => (
                  <Row key={t} type={t} value={data.active[t][hover] ? "Active" : "—"} />
                ))}
              </>
            )}
          </Tooltip>
        )}
      </div>

      <details className="mt-3 text-xs text-secondary">
        <summary className="cursor-pointer select-none text-muted">View as table</summary>
        <TimelineTable data={data} />
      </details>
    </div>
  );
}

function Row({ type, value }: { type: keyof typeof TYPE_LABEL; value: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="inline-block h-[2px] w-3" style={{ background: `var(--s-${type})` }} />
      <span className="w-14 text-right font-semibold tnum">{value}</span>
      <span className="text-secondary">{TYPE_LABEL[type]}</span>
    </div>
  );
}

function TimelineTable({ data }: { data: Timeline }) {
  const rows = data.buckets
    .map((b, i) => ({ b, i }))
    .filter(({ i }) =>
      data.offline[i] ||
      MINUTE_TYPES.some((t) => data.minutes[t][i] != null) ||
      SPAN_TYPES.some((t) => data.active[t][i])
    )
    .reverse();
  if (rows.length === 0) return <p className="mt-2">No disruptions reported in this window.</p>;
  return (
    <div className="mt-2 max-h-72 overflow-auto">
      <table className="w-full tnum">
        <thead>
          <tr className="text-left text-muted">
            <th className="py-1 pr-3 font-medium">Time (UTC)</th>
            {MINUTE_TYPES.map((t) => <th key={t} className="py-1 pr-3 text-right font-medium">{TYPE_LABEL[t]}</th>)}
            {SPAN_TYPES.map((t) => <th key={t} className="py-1 pr-3 text-right font-medium">{TYPE_LABEL[t]}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ b, i }) => (
            <tr key={b} style={{ borderTop: "1px solid var(--border)" }}>
              <td className="whitespace-nowrap py-1 pr-3">{b.slice(0, 16).replace("T", " ")}</td>
              {data.offline[i] ? (
                <td colSpan={MINUTE_TYPES.length + SPAN_TYPES.length} className="py-1 text-right text-muted">pipeline offline</td>
              ) : (
                <>
                  {MINUTE_TYPES.map((t) => (
                    <td key={t} className="py-1 pr-3 text-right">{formatMinutes(data.minutes[t][i])}</td>
                  ))}
                  {SPAN_TYPES.map((t) => (
                    <td key={t} className="py-1 pr-3 text-right">{data.active[t][i] ? "yes" : "—"}</td>
                  ))}
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Tooltip({ x, width, children }: { x: number; width: number; children: React.ReactNode }) {
  const W = 200;
  // sit beside the crosshair so it never hides the values under it
  const left = x + 12 + W <= width ? x + 12 : Math.max(0, x - 12 - W);
  return (
    <div className="pointer-events-none absolute top-0 z-10 rounded-lg px-3 py-2.5"
      style={{ left, width: W, background: "var(--card)", border: "1px solid var(--border)", boxShadow: "0 8px 24px rgba(0,0,0,0.12)" }}>
      {children}
    </div>
  );
}

/** Contiguous [start, end] index runs where the flag is true. */
function runs(flags: boolean[]): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  flags.forEach((f, i) => {
    if (f && start < 0) start = i;
    if (!f && start >= 0) {
      out.push([start, i - 1]);
      start = -1;
    }
  });
  if (start >= 0) out.push([start, flags.length - 1]);
  return out;
}

/** Axis max on a clean step so the midpoint tick is a round duration too. */
function niceMax(v: number) {
  const steps = [60, 120, 180, 240, 360, 480, 600, 720, 960, 1200, 1440];
  return steps.find((s) => s >= v) ?? Math.ceil(v / 240) * 240;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Bucket indexes that start a UTC day. */
function dayBoundaries(buckets: string[]) {
  const out: { i: number; label: string }[] = [];
  buckets.forEach((b, i) => {
    if (b.slice(11, 16) === "00:00") {
      const [, m, d] = b.slice(0, 10).split("-").map(Number);
      out.push({ i, label: `${MONTHS[m - 1]} ${d}` });
    }
  });
  return out;
}

function bucketLabel(start: string, minutes: number) {
  const a = new Date(start);
  const b = new Date(a.getTime() + minutes * 60000);
  const day = a.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const hm = (d: Date) => d.toISOString().slice(11, 16);
  return `${day}, ${hm(a)}–${hm(b)} UTC`;
}
