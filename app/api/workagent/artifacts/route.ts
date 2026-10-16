import { NextResponse } from "next/server";
import { listArtifacts, workspacePath } from "@/lib/workagent/workspace";
import { officeErrorResponse } from "@/lib/workagent/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams;
    return NextResponse.json(await listArtifacts(query.get("cwd") ?? workspacePath(), process.cwd(), Number(query.get("limit") ?? 100)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return officeErrorResponse(error); }
}
