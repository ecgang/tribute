import { NextResponse } from "next/server";
import { discoverRsl } from "@/lib/rslDiscovery";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url).searchParams.get("url");
  if (!url) return NextResponse.json({ error: "missing_url" }, { status: 400 });
  const terms = await discoverRsl(url, { tryLive: true });
  return NextResponse.json(terms);
}
