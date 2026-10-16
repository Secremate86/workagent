import { NextResponse } from "next/server";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { createScheduledTask, deleteScheduledTask, scheduleSnapshot } from "@/lib/workagent/automation";
import { OfficeError } from "@/lib/workagent/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function readBody(request: Request) {
  if (!isApiRequestAllowed(request)) throw new OfficeError("UNTRUSTED_ORIGIN", "请求来源不受信任", 403);
  if (!hasJsonContentType(request)) throw new OfficeError("UNSUPPORTED_MEDIA_TYPE", "请使用 JSON 请求", 415);
  if (Number(request.headers.get("content-length") ?? 0) > 16_384) throw new OfficeError("REQUEST_TOO_LARGE", "定时任务请求超过大小限制", 413);
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > 16_384) throw new OfficeError("REQUEST_TOO_LARGE", "定时任务请求超过大小限制", 413);
  try { return JSON.parse(text) as unknown; }
  catch { throw new OfficeError("INVALID_JSON", "请求不是有效 JSON", 400); }
}

function errorResponse(error: unknown) {
  const office = error instanceof OfficeError ? error : null;
  return NextResponse.json({ error: office?.message ?? "定时任务服务暂时不可用", code: office?.code ?? "SCHEDULES_ERROR" }, { status: office?.status ?? 500 });
}

export async function GET(request: Request) {
  try {
    if (!isApiRequestAllowed(request)) throw new OfficeError("UNTRUSTED_ORIGIN", "请求来源不受信任", 403);
    return NextResponse.json(await scheduleSnapshot());
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    return NextResponse.json(await createScheduledTask(body), { status: 201 });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    const body = await readBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as { id?: unknown }).id !== "string") {
      throw new OfficeError("INVALID_REQUEST", "删除请求必须包含 id", 400);
    }
    return NextResponse.json(await deleteScheduledTask((body as { id: string }).id));
  } catch (error) { return errorResponse(error); }
}
