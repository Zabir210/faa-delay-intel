import { getPipelineHealth } from "@/lib/db/queries";

export async function GET() {
  try {
    const health = await getPipelineHealth();
    return Response.json(health);
  } catch (err) {
    console.error("GET /api/health failed", err);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
