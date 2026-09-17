import { getCurrentDisruptions } from "@/lib/db/queries";

export async function GET() {
  try {
    const disruptions = await getCurrentDisruptions();
    return Response.json({ disruptions });
  } catch (err) {
    console.error("GET /api/current failed", err);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
