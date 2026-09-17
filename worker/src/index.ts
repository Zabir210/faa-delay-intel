/**
 * Reliable alarm clock for FAA ingestion.
 *
 * Fires on Cloudflare's Cron Trigger scheduler (not GitHub Actions'
 * shared/best-effort `schedule` queue) and dispatches the existing
 * `ingest.yml` workflow via the GitHub REST API's workflow_dispatch
 * event. All parsing/loading logic stays in the tested Python pipeline —
 * this Worker contains no ingestion logic, only the trigger.
 */

export interface Env {
  GITHUB_TOKEN: string;
}

const OWNER = "Zabir210";
const REPO = "faa-delay-intel";
const WORKFLOW_FILE = "ingest.yml";
const REF = "main";

async function dispatchIngest(env: Env): Promise<Response> {
  const url =
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/` +
    `${WORKFLOW_FILE}/dispatches`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "faa-delay-intel-scheduler-worker",
    },
    body: JSON.stringify({ ref: REF }),
  });

  if (!response.ok) {
    const body = await response.text();
    // Surface loudly: a failed dispatch here means a real gap in the
    // dataset, same as a failed ingest run would.
    throw new Error(
      `GitHub dispatch failed: ${response.status} ${response.statusText} — ${body}`
    );
  }

  return response;
}

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(
      dispatchIngest(env)
        .then(() => console.log("dispatched ingest.yml"))
        .catch((err) => {
          console.error("dispatch failed", err);
          throw err; // non-2xx scheduled invocation shows as an error in Cloudflare logs
        })
    );
  },

  // Manual trigger for testing: `curl https://<worker>.workers.dev/`
  async fetch(_request: Request, env: Env): Promise<Response> {
    try {
      await dispatchIngest(env);
      return new Response("dispatched ingest.yml\n", { status: 200 });
    } catch (err) {
      return new Response(`error: ${(err as Error).message}\n`, {
        status: 502,
      });
    }
  },
};
