"use client";

import { useLayoutEffect, useRef, useState } from "react";

import { DELAY_TYPES, TYPE_LABEL, type DailyActivity, type DelayType } from "@/lib/delay-types";

const H = 220;
const PAD = { top: 12, right: 8, bottom: 26, left: 32 };
const GAP = 2; // surface gap between stacked segments

/** Stacked columns: delay events started per UTC day, by type. Days with no
 * ingest runs render as hatched "no data" columns, not as calm days. */
export function ActivityChart({ data }: { data: DailyActivity[] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const totals = data.map((d) => DELAY_TYPES.reduce((s, t) => s + d.counts[t], 0));
  const max = niceMax(Math.max(4, ...totals));
  const ticks = [0, max / 2, max];
  const innerW = width - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const band = innerW / data.length;
  const barW = Math.min(24, Math.max(4, band * 0.62));
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const labelEvery = Math.ceil(data.length / Math.max(2, Math.floor(innerW / 64)));
  const today = data.length - 1;
  const h = hover != null ? data[hover] : null;

  return (
    <div>
      <ul className="mb-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-secondary">
        {DELAY_TYPES.map((t) => (
          <li key={t} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: `var(--s-${t})` }} />
            {TYPE_LABEL[t]}
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ backgroundImage: "repeating-linear-gradient(45deg, var(--nodata-ink) 0 2px, var(--nodata) 2px 5px)" }} />
          Pipeline offline
        </li>
      </ul>

      <div ref={wrap} className="relative" onPointerLeave={() => setHover(null)}>
        <svg width={width} height={H} role="img" aria-label="Delay events started per day, stacked by type">
          <defs>
            <pattern id="nodata" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="5" height="5" fill="var(--nodata)" />
              <rect width="2" height="5" fill="var(--nodata-ink)" />
            </pattern>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)}
                stroke={t === 0 ? "var(--baseline)" : "var(--grid)"} strokeWidth={1} />
              <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--muted)" className="tnum">
                {t}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = PAD.left + band * i + band / 2;
            const x = cx - barW / 2;
            const offline = d.runs === 0;
            let acc = 0;
            const segs = DELAY_TYPES.filter((t) => d.counts[t] > 0);
            return (
              <g key={d.day} opacity={hover == null || hover === i ? 1 : 0.45} style={{ transition: "opacity 120ms" }}>
                {offline ? (
                  <rect x={x} y={y(max * 0.18)} width={barW} height={y(0) - y(max * 0.18)} fill="url(#nodata)" rx={3} />
                ) : (
                  segs.map((t, k) => {
                    const v = d.counts[t];
                    const top = y(acc + v);
                    const bottom = y(acc) - (k > 0 ? GAP : 0);
                    acc += v;
                    const isTop = k === segs.length - 1;
                    return (
                      <path key={t} d={columnPath(x, top, barW, Math.max(1, bottom - top), isTop ? 4 : 0)} fill={`var(--s-${t})`} />
                    );
                  })
                )}
                {i % labelEvery === (today % labelEvery) && (
                  <text x={cx > width - PAD.right - 20 ? cx + barW / 2 : cx} y={H - 8}
                    textAnchor={cx > width - PAD.right - 20 ? "end" : "middle"} fontSize={11} fill="var(--muted)">
                    {shortDay(d.day)}
                  </text>
                )}
                {/* hit target: the whole band, taller than the mark */}
                <rect x={PAD.left + band * i} y={PAD.top} width={band} height={innerH} fill="transparent"
                  tabIndex={0} aria-label={describe(d, i === today)}
                  onPointerEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
              </g>
            );
          })}
        </svg>

        {h && hover != null && (
          <Tooltip x={PAD.left + band * hover + band / 2} width={width}>
            <div className="mb-1.5 text-xs text-secondary">
              {longDay(h.day)}{hover === today ? " · so far" : ""}
            </div>
            {h.runs === 0 ? (
              <div className="text-sm text-secondary">No data: ingest pipeline was offline</div>
            ) : (
              <>
                <div className="mb-1.5 text-base font-semibold tnum">{totals[hover]} events</div>
                {DELAY_TYPES.map((t) => (
                  <div key={t} className="flex items-center gap-2 text-xs">
                    <span className="inline-block h-[2px] w-3" style={{ background: `var(--s-${t})` }} />
                    <span className="w-6 text-right font-semibold tnum">{h.counts[t]}</span>
                    <span className="text-secondary">{TYPE_LABEL[t]}</span>
                  </div>
                ))}
                {h.runs < 280 && hover !== today && (
                  <div className="mt-1.5 text-xs text-muted">{h.runs}/288 runs: partial coverage</div>
                )}
              </>
            )}
          </Tooltip>
        )}
      </div>

      <details className="mt-3 text-xs text-secondary">
        <summary className="cursor-pointer select-none text-muted">View as table</summary>
        <div className="mt-2 max-h-64 overflow-auto">
          <table className="w-full tnum">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1 pr-3 font-medium">Day (UTC)</th>
                {DELAY_TYPES.map((t) => <th key={t} className="py-1 pr-3 text-right font-medium">{TYPE_LABEL[t]}</th>)}
                <th className="py-1 text-right font-medium">Runs</th>
              </tr>
            </thead>
            <tbody>
              {[...data].reverse().map((d) => (
                <tr key={d.day} style={{ borderTop: "1px solid var(--border)" }}>
                  <td className="py-1 pr-3">{d.day}</td>
                  {DELAY_TYPES.map((t: DelayType) => (
                    <td key={t} className="py-1 pr-3 text-right">{d.runs === 0 ? "–" : d.counts[t]}</td>
                  ))}
                  <td className="py-1 text-right">{d.runs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function Tooltip({ x, width, children }: { x: number; width: number; children: React.ReactNode }) {
  const W = 190;
  const left = Math.min(Math.max(0, x - W / 2), width - W);
  return (
    <div className="pointer-events-none absolute top-0 z-10 rounded-lg px-3 py-2.5"
      style={{ left, width: W, background: "var(--card)", border: "1px solid var(--border)", boxShadow: "0 8px 24px rgba(0,0,0,0.12)" }}>
      {children}
    </div>
  );
}

/** Column with optional rounded top corners, square at the baseline. */
function columnPath(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function niceMax(v: number) {
  const step = v <= 10 ? 2 : v <= 40 ? 10 : 20;
  return Math.ceil(v / step) * step;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDay(day: string) {
  const [, m, d] = day.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}
function longDay(day: string) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", timeZone: "UTC",
  });
}
function describe(d: DailyActivity, isToday: boolean) {
  if (d.runs === 0) return `${d.day}: no data, pipeline offline`;
  const parts = DELAY_TYPES.map((t) => `${d.counts[t]} ${TYPE_LABEL[t]}`).join(", ");
  return `${d.day}${isToday ? " so far" : ""}: ${parts}`;
}
