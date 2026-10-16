import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { saveQuickModel } from "@/lib/workagent/model-config";
import { officeErrorResponse } from "@/lib/workagent/http";
import { OfficeError } from "@/lib/workagent/workspace";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    if (!isApiRequestAllowed(request)) throw new OfficeError("REQUEST_DENIED", "请求来源不受信任", 403);
    if (!hasJsonContentType(request)) throw new OfficeError("CONTENT_TYPE", "请使用 JSON 请求", 415);
    const text = await request.text();
    if (Buffer.byteLength(text) > 12_000) throw new OfficeError("REQUEST_TOO_LARGE", "配置内容过大", 413);
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new OfficeError("INVALID_JSON", "配置内容不是有效 JSON"); }
    return NextResponse.json(await saveQuickModel(body), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return officeErrorResponse(error); }
}
