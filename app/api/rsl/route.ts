import { NextResponse } from "next/server";
import { z } from "zod";
import { discoverRsl } from "@/lib/rslDiscovery";

export const runtime = "nodejs";

const QuerySchema = z.string().url().max(2048);

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("url");
  if (!raw) return NextResponse.json({ error: "missing_url" }, { status: 400 });
  const parsed = QuerySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  const terms = await discoverRsl(parsed.data, { tryLive: true });
  return NextResponse.json(terms);
}
