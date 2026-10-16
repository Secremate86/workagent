import { NextResponse } from "next/server";
import { readPolicy, writePolicyMode } from "@/lib/workagent/policy";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET() {
  try { return NextResponse.json(readPolicy(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 500 }); }
}
export async function PUT(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "请求来源不受信任" }, { status: 403 });
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "请使用 JSON 请求" }, { status: 415 });
  try {
    const text = await request.text();
    if (text.length > 1000) return NextResponse.json({ error: "请求过大" }, { status: 413 });
    return NextResponse.json(writePolicyMode(JSON.parse(text).mode));
  } catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 400 }); }
}
