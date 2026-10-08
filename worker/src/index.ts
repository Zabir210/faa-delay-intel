/**
 * FAA delay ingestion, running entirely on Cloudflare Workers.
 *
 * The Cron Trigger calls the full pipeline (fetch -> parse -> load ->
 * events -> anomalies -> ingest_runs) and writes to Neon over the
 * serverless driver's WebSocket client (needed for real transactions).
 * GitHub Actions is no longer in the ingestion path.
 *
 * HTTP:
 *   GET  /        -> JSON health: latest ingest_runs row (read-only)
 *   POST /run     -> run one ingestion now; requires
 *                    `Authorization: Bearer <TRIGGER_TOKEN>` and is disabled
 *                    unless the TRIGGER_TOKEN secret is set.
 */
import { Client } from "@neondatabase/serverless";
import { runIngest, type Db, type RunSummary } from "./pipeline.ts";

export interface Env {
  DATABASE_URL: string;
  TRIGGER_TOKEN?: string;
  SELF_URL?: string;
}

/** Rejects after `ms` so a stuck socket can never hang the invocation. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TimeoutError: ${what} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

function connector(env: Env) {
  return async (): Promise<Db & { end: () => Promise<void> }> => {
    if (!env.DATABASE_URL) throw new Error("ConfigError: DATABASE_URL secret is not set");
    const client = new Client(env.DATABASE_URL);
    // An unhandled 'error' event would crash the invocation; log it instead.
    // After an intentional end(), Workers tears down the WebSocket when the
    // request finishes and the client emits a late "Network connection
    // lost" — expected, so it is not logged as an error.
    let closing = false;
    client.on("error", (err) => {
      if (!closing) console.error("db client error", err);
    });
    // end() on a client whose connect() failed never resolves, so closing is
    // fire-and-forget with a bound — never awaited unbounded.
    const close = () => {
      closing = true;
      return withTimeout(client.end(), 5_000, "db close").catch(() => {});
    };
    try {
      await withTimeout(client.connect(), 15_000, "db connect");
    } catch (err) {
      void close();
      throw err;
    }
    return {
      query: (text: string, params?: unknown[]) =>
        withTimeout(client.query(text, params as any[]), 60_000, "db query"),
      end: close,
    };
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) {
    diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  }
  return diff === 0;
}

async function run(env: Env): Promise<RunSummary> {
  return runIngest({ connect: connector(env) });
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    // Cron invocations run in an arbitrary Cloudflare location (observed:
    // Mumbai), and the FAA feed answers 403 to non-US egress. Placement
    // only applies to HTTP requests, so the cron re-enters the Worker over
    // HTTP and the run executes at the pinned US placement. If that hop
    // itself fails, run inline (idempotent + advisory-locked, so a
    // duplicate run is harmless).
    let summary: RunSummary | null = null;
    if (env.SELF_URL && env.TRIGGER_TOKEN) {
      try {
        const res = await fetch(new URL("/run", env.SELF_URL), {
          method: "POST",
          headers: { Authorization: `Bearer ${env.TRIGGER_TOKEN}` },
          signal: AbortSignal.timeout(120_000),
        });
        const body = (await res.json()) as RunSummary;
        if (typeof body?.status === "string") summary = body;
        console.log(`placed run via ${res.headers.get("cf-placement") ?? "?"}: ${body.status}`);
      } catch (err) {
        console.warn(`placed run unavailable (${(err as Error).message}); running inline`);
      }
    }
    summary ??= await run(env);
    if (summary.status !== "ok") {
      // Marks the invocation failed in Cloudflare observability (the old
      // "red CI run" signal). The failure is already in ingest_runs.
      throw new Error(`ingest failed: ${summary.error}`);
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/run") {
      if (request.method !== "POST") return new Response("method not allowed\n", { status: 405 });
      const expected = env.TRIGGER_TOKEN;
      const got = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (!expected || !timingSafeEqual(got, expected)) {
        return new Response("unauthorized\n", { status: 401 });
      }
      const summary = await run(env);
      return Response.json(summary, { status: summary.status === "ok" ? 200 : 502 });
    }

    if (url.pathname === "/" && request.method === "GET") {
      try {
        const db = await connector(env)();
        try {
          const res = await db.query(
            "SELECT ran_at, status, records_seen, records_new, feed_update_time, " +
              "duration_ms, error FROM ingest_runs ORDER BY ran_at DESC LIMIT 1"
          );
          return Response.json({ service: "faa-delay-intel-ingest", last_run: res.rows[0] ?? null });
        } finally {
          await db.end().catch(() => {});
        }
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 503 });
      }
    }

    return new Response("not found\n", { status: 404 });
  },
};
