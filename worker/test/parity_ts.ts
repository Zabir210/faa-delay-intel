/**
 * Parity harness, TypeScript side. LOCAL DOCKER DATABASES ONLY.
 * Mirrors worker/test/parity_py.py; run with `node test/parity_ts.ts ...`.
 */
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import pg from "pg";
import { deriveEvents } from "../src/events.ts";
import { parseNasStatus } from "../src/parser.ts";
import { runIngest } from "../src/pipeline.ts";

const iso = (d: Date | null) => (d ? d.toISOString().replace(/\.\d{3}Z$/, "Z") : null);

function guard(dsn: string) {
  const host = new URL(dsn).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.error(`refusing non-local database host: ${host}`);
    process.exit(2);
  }
}

function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  }
  return v;
}

function readJsonl(path: string): any[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function cmdParse(inp: string, out: string) {
  const lines: string[] = [];
  for (const doc of readJsonl(inp)) {
    let res: any;
    try {
      const r = parseNasStatus(doc.xml);
      res = { id: doc.id, update_time: iso(r.update_time), records: r.records };
    } catch {
      res = { id: doc.id, error: "ParseError" };
    }
    lines.push(JSON.stringify(sortKeys(res)));
  }
  writeFileSync(out, lines.join("\n") + "\n");
}

async function cmdEvents(dsn: string, out: string) {
  guard(dsn);
  const c = new pg.Client(dsn);
  await c.connect();
  const obs = await c.query(
    `SELECT airport, delay_type, direction, reason, update_time,
            min_delay_minutes, max_delay_minutes
     FROM observations ORDER BY update_time`
  );
  const snaps = await c.query("SELECT DISTINCT update_time FROM observations ORDER BY update_time");
  await c.end();
  const t0 = process.cpuUsage();
  const events = deriveEvents(obs.rows, snaps.rows.map((r) => r.update_time));
  const cpu = process.cpuUsage(t0);
  console.error(`deriveEvents over ${obs.rows.length} obs: ${(cpu.user + cpu.system) / 1000}ms CPU`);
  writeFileSync(
    out,
    JSON.stringify(
      sortKeys(
        events.map((e) => ({
          ...e,
          started_at: iso(e.started_at),
          last_seen_at: iso(e.last_seen_at),
          ended_at: iso(e.ended_at),
        }))
      )
    )
  );
}

async function cmdReplay(dsn: string, snapshots: string, firstIdx: string, out: string) {
  guard(dsn);
  const docs = readJsonl(snapshots).slice(Number(firstIdx));
  const clock = new pg.Client(dsn);
  await clock.connect();
  writeFileSync(out, "");
  let maxCpu = 0;
  for (const doc of docs) {
    await clock.query(
      "UPDATE fake_clock SET t = $1::timestamptz + interval '2 minutes'",
      [doc.id]
    );
    let okLine = "";
    const warnings: string[] = [];
    const t0 = process.cpuUsage();
    const summary = await runIngest({
      connect: async () => {
        const c = new pg.Client(dsn);
        await c.connect();
        return { query: (t, p) => c.query(t, p as any[]), end: () => c.end() };
      },
      fetchXml: async () => doc.xml,
      sleep: async () => {},
      log: (m) => (okLine = m),
      warn: (m) => warnings.push(m),
    });
    const cpu = process.cpuUsage(t0);
    maxCpu = Math.max(maxCpu, (cpu.user + cpu.system) / 1000);
    const m = /ok: (\d+) seen, (\d+) new, (\d+) events, (\d+) anomalies/.exec(okLine);
    appendFileSync(
      out,
      JSON.stringify({
        id: doc.id,
        rc: summary.status === "ok" ? 0 : 1,
        summary: m ? m.slice(1).map(Number) : null,
        warnings: warnings.join("\n") || null,
      }) + "\n"
    );
  }
  await clock.end();
  console.error(`max CPU per run (node, includes pg driver): ${maxCpu.toFixed(1)}ms`);
}

const [cmd, ...args] = process.argv.slice(2);
const table: Record<string, (...a: string[]) => Promise<void>> = {
  parse: cmdParse,
  events: cmdEvents,
  replay: cmdReplay,
};
await table[cmd](...args);
