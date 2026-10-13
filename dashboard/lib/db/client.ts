import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

// Neon's serverless HTTP driver — one query per fetch, no pooled TCP
// connection to manage, which is what makes this safe to call from a
// Vercel serverless function (each invocation is a fresh process).
//
// Created on first query, not at import: `next build` imports every route
// while collecting page data, so an import-time throw failed any build
// without DATABASE_URL (e.g. Vercel Preview, where only Production has the
// secret). A missing URL now fails the request that needs it, with the
// same message.
let client: NeonQueryFunction<false, false> | null = null;

function getClient(): NeonQueryFunction<false, false> {
  if (!client) {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "DATABASE_URL is not set. Copy .env.local from the project root " +
          "(see ../DEPLOY.md), or run `neon link` in the dashboard directory."
      );
    }
    client = neon(process.env.DATABASE_URL);
  }
  return client;
}

/** Tagged-template query, same call shape as neon()'s `sql\`...\``. */
export function sql(strings: TemplateStringsArray, ...values: unknown[]) {
  return getClient()(strings, ...values);
}
