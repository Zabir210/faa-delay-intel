import { neon } from "@neondatabase/serverless";

// Neon's serverless HTTP driver — one query per fetch, no pooled TCP
// connection to manage, which is what makes this safe to call from a
// Vercel serverless function (each invocation is a fresh process).
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.local from the project root " +
      "(see ../DEPLOY.md), or run `neon link` in the dashboard directory."
  );
}

export const sql = neon(process.env.DATABASE_URL);
