import { NextResponse } from "next/server";
import { evaluate } from "@/lib/eval";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(evaluate());
}
