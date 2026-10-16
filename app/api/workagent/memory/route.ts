import { NextResponse } from "next/server";
import { isApiRequestAllowed, hasJsonContentType } from "../../../../lib/request-security";
import { addMemory, deleteMemory, memorySnapshot } from "../../../../lib/workagent/memory";
import { assertExecutionMutationAllowed } from "../../../../lib/workagent/policy";
import { officeErrorResponse } from "../../../../lib/workagent/http";
import { OfficeError } from "../../../../lib/workagent/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!isApiRequestAllowed(request)) throw new OfficeError("UNTRUSTED_ORIGIN", "请求来源不受信任", 403);
  if (!hasJsonContentType(request)) throw new OfficeError("UNSUPPORTED_MEDIA_TYPE", "请使用 JSON 请求", 415);
  if (Number(request.headers.get("content-length") ?? 0) > 32_768) throw new OfficeError("REQUEST_TOO_LARGE", "记忆请求超过大小限制", 413);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 32_768) { await reader.cancel(); throw new OfficeError("REQUEST_TOO_LARGE", "记忆请求超过大小限制", 413); }
      chunks.push(value);
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new OfficeError("INVALID_JSON", "请求不是有效 JSON", 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new OfficeError("INVALID_REQUEST", "请求必须是 JSON 对象", 400);
  return body as Record<string, unknown>;
}

export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    assertExecutionMutationAllowed();
    const entry = await addMemory(body.content);
    return NextResponse.json({ ok: true, ...entry }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return officeErrorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    const body = await readBody(request);
    assertExecutionMutationAllowed();
    const target = body.target === "daily" ? "daily" : "long_term";
    if (body.target !== undefined && body.target !== "daily" && body.target !== "long_term") throw new OfficeError("INVALID_MEMORY_TARGET", "记忆目标无效", 400);
    await deleteMemory(body.id, process.cwd(), target, typeof body.date === "string" ? body.date : undefined);
    return NextResponse.json({ ok: true, id: body.id }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return officeErrorResponse(error); }
}

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ ok: false, code: "UNTRUSTED_ORIGIN", error: "请求来源不受信任" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  try { return NextResponse.json(await memorySnapshot(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return officeErrorResponse(error); }
}
