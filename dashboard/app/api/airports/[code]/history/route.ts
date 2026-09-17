import type { NextRequest } from "next/server";

import { getAirportHistory } from "@/lib/db/queries";

const AIRPORT_CODE_RE = /^[A-Z0-9]{3,4}$/;

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/airports/[code]/history">
) {
  const { code } = await ctx.params;
  const airport = code.toUpperCase();

  if (!AIRPORT_CODE_RE.test(airport)) {
    return Response.json({ error: "invalid airport code" }, { status: 400 });
  }

  const daysParam = request.nextUrl.searchParams.get("days");
  const days = daysParam ? Number(daysParam) : 7;
  if (!Number.isFinite(days) || days <= 0) {
    return Response.json({ error: "days must be a positive number" }, {
      status: 400,
    });
  }

  try {
    const history = await getAirportHistory(airport, days);
    return Response.json({ airport, days, history });
  } catch (err) {
    console.error("GET /api/airports/[code]/history failed", err);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
