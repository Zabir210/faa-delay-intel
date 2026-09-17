import type { NextRequest } from "next/server";

import { getWorstAirports } from "@/lib/db/queries";

export async function GET(request: NextRequest) {
  const daysParam = request.nextUrl.searchParams.get("days");
  const days = daysParam ? Number(daysParam) : 30;
  if (!Number.isFinite(days) || days <= 0) {
    return Response.json({ error: "days must be a positive number" }, {
      status: 400,
    });
  }

  try {
    const airports = await getWorstAirports(days);
    return Response.json({ days, airports });
  } catch (err) {
    console.error("GET /api/stats/worst failed", err);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
