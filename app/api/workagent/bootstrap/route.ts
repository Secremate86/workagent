import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { allowFileRoot } from "@/lib/file-access";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { ensureWorkspace } from "@/lib/workagent/workspace";
import { officeReadiness } from "@/lib/workagent/office";
import { officeErrorResponse } from "@/lib/workagent/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const workspace = await ensureWorkspace();
    allowFileRoot(workspace.cwd);
    const projectTrust = getProjectTrustStatus(workspace.cwd, getAgentDir());
    return NextResponse.json({ ...workspace, ...await officeReadiness(), projectTrust, needsTrust: !projectTrust.trusted }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return officeErrorResponse(error); }
}
