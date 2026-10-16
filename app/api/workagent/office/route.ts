import { NextResponse } from "next/server";
import { executeOffice } from "@/lib/workagent/office";
import { assertExecutionMutationAllowed } from "@/lib/workagent/policy";
import { OfficeError } from "@/lib/workagent/workspace";
import { officeErrorResponse } from "@/lib/workagent/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 65_536) throw new OfficeError("REQUEST_TOO_LARGE", "办公请求超过大小限制", 413);
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > 65_536) throw new OfficeError("REQUEST_TOO_LARGE", "办公请求超过大小限制", 413);
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new OfficeError("INVALID_JSON", "请求不是有效 JSON"); }
    // The deterministic Office operation is an explicit user action, but plan mode
    // must block artifact creation on this direct HTTP path as well as in Pi.
    assertExecutionMutationAllowed();
    return NextResponse.json(await executeOffice(body, { signal: request.signal }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return officeErrorResponse(error); }
}
