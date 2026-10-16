import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, type InlineExtension, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { isExistingPathWithinRoots } from "../path-security";
import { OfficeError } from "./workspace";
import { emitPolicyMode } from "./policy-events";

export type ExecutionMode = "review" | "auto" | "plan";
export const WORKAGENT_POLICY_EXTENSION_PATH = "<inline:workagent-execution-policy>";
export const WORKAGENT_POLICY_VERSION = "2026-10-16-v4";
export interface PolicyAudit {
  id: string; at: string; sessionId?: string; toolName: string;
  decision: "allowed" | "denied" | "blocked" | "auto"; reason: string; summary: string;
}
export interface ExecutionPolicy { mode: ExecutionMode; updatedAt: string; revision: string; audit: PolicyAudit[] }
const MODES = new Set(["review", "auto", "plan"]);
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const CONTROL_TOOLS = new Set(["get_subagent_result", "steer_subagent", "tool_search"]);
const SAFE_OFFICE = new Set(["office_inventory", "office_reconcile", "office_report"]);
const MEMORY_READ = new Set(["memory_read", "memory_status", "memory_search", "cron_list"]);

function policyPath(agentDir: string) { return path.join(agentDir, "workagent-policy.json"); }
export function readPolicy(agentDir = getAgentDir()): ExecutionPolicy {
  try {
    const raw = JSON.parse(readFileSync(policyPath(agentDir), "utf8"));
    if (!MODES.has(raw.mode) || !Array.isArray(raw.audit)) throw new Error("Invalid execution policy");
    const updatedAt = String(raw.updatedAt ?? "");
    return { mode: raw.mode, updatedAt, revision: typeof raw.revision === "string" ? raw.revision : updatedAt, audit: raw.audit.slice(-200) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mode: "review", updatedAt: "", revision: "", audit: [] };
    // A corrupt policy must never fall back to unrestricted execution.
    throw new Error("执行策略文件无法读取，请修复配置后再执行任务", { cause: error });
  }
}
function save(policy: ExecutionPolicy, agentDir: string) {
  mkdirSync(agentDir, { recursive: true });
  writePrivateFileAtomicSync(policyPath(agentDir), JSON.stringify(policy, null, 2));
  return policy;
}
export function writePolicyMode(mode: unknown, agentDir = getAgentDir()) {
  if (typeof mode !== "string" || !MODES.has(mode)) throw new Error("模式必须为 review、auto 或 plan");
  const policy = save({ ...readPolicy(agentDir), mode: mode as ExecutionMode, updatedAt: new Date().toISOString(), revision: randomUUID() }, agentDir);
  emitPolicyMode(agentDir, policy.mode);
  return policy;
}
export function recordPolicyDecision(entry: Omit<PolicyAudit, "id" | "at">, agentDir = getAgentDir()) {
  const policy = readPolicy(agentDir);
  policy.audit.push({ ...entry, id: randomUUID(), at: new Date().toISOString() });
  policy.audit = policy.audit.slice(-200);
  save(policy, agentDir);
}
export function assertExecutionMutationAllowed(agentDir = getAgentDir()) {
  if (readPolicy(agentDir).mode === "plan") throw new OfficeError("PLAN_MODE_BLOCKED", "计划模式只允许分析；请切换到安全审查或默认放行后操作", 403);
}

/** Full input is only sent to the live approval dialog; persistent history stores metadata. */
function auditSummary(toolName: string, input: Record<string, unknown>) {
  const target = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : "";
  return `${toolName}${target ? ` · ${target.replace(/[\r\n]/g, " ").slice(0, 240)}` : ""}`;
}
function approvalDetails(input: Record<string, unknown>) {
  // Credential fields are not needed to decide whether an action is allowed.
  return JSON.stringify(input, (key, value) => /key|token|secret|password|authorization|cookie/i.test(key) ? "[已隐藏]" : value, 2).slice(0, 6000);
}
export async function authorizeWorkAgentAction(options: {
  agentDir?: string;
  sessionId?: string;
  toolName: string;
  tool?: Pick<ToolInfo, "name" | "annotations">;
  input: Record<string, unknown>;
  cwd: string;
  hasUI: boolean;
  confirm?: (title: string, message: string, opts: { timeout: number; signal?: AbortSignal }) => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<{ allowed: boolean; reason: string }> {
  const agentDir = options.agentDir ?? getAgentDir();
  const tool = options.tool ?? { name: options.toolName };
  const classification = classifyToolCall(tool, options.input, options.cwd);
  const initial = readPolicy(agentDir);
  const entry = {
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    toolName: options.toolName,
    reason: classification.reason,
    summary: auditSummary(options.toolName, options.input),
  };
  if (initial.mode === "plan") {
    recordPolicyDecision({ ...entry, decision: classification.planSafe ? "allowed" : "blocked" }, agentDir);
    return { allowed: classification.planSafe, reason: classification.reason };
  }
  if (initial.mode === "auto") {
    recordPolicyDecision({ ...entry, decision: "auto" }, agentDir);
    return { allowed: true, reason: classification.reason };
  }
  if (classification.safe) {
    recordPolicyDecision({ ...entry, decision: "allowed" }, agentDir);
    return { allowed: true, reason: classification.reason };
  }
  let confirmed = false;
  if (options.hasUI && options.confirm) {
    try {
      confirmed = (await options.confirm(
        "高风险操作审批",
        `会话：${options.sessionId ?? "直接操作"}\n工具：${options.toolName}\n工作区：${options.cwd}\n原因：${classification.reason}\n\n${approvalDetails(options.input)}\n\n仅批准这一次调用。取消、关闭或超时将拒绝执行。`,
        { timeout: 120_000, signal: options.signal },
      )) === true;
    } catch {
      confirmed = false;
    }
  }
  const current = readPolicy(agentDir);
  if (current.mode !== "review" || current.revision !== initial.revision || options.signal?.aborted) confirmed = false;
  recordPolicyDecision({
    ...entry,
    decision: confirmed ? "allowed" : "denied",
    ...(!options.hasUI ? { reason: "无交互界面，无法获得审批" } : {}),
  }, agentDir);
  return { allowed: confirmed, reason: classification.reason };
}
export function classifyToolCall(tool: Pick<ToolInfo, "name" | "annotations">, input: Record<string, unknown>, cwd: string): { safe: boolean; reason: string; planSafe: boolean } {
  const name = tool.name;
  if (CONTROL_TOOLS.has(name)) return { safe: true, planSafe: true, reason: "受控的工具发现或子代理通信" };
  // Children inherit this host policy; spawning does not grant them unrestricted tools.
  if (name === "Agent") return { safe: true, planSafe: true, reason: "子代理继续受同一执行策略约束" };
  if (READ_TOOLS.has(name)) {
    const target = input.path ?? input.file_path ?? ".";
    const file = typeof target === "string" ? path.resolve(cwd, target) : "";
    const sensitive = /(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|auth\.json|id_(?:rsa|ed25519)|credentials(?:\.[^\\/]*)?)(?:$|[\\/])/i.test(file);
    const inside = !!file && isExistingPathWithinRoots(file, new Set([cwd]));
    return { safe: inside && !sensitive, planSafe: inside && !sensitive, reason: sensitive ? "读取可能包含凭据的文件" : inside ? "读取当前工作区" : "读取当前工作区以外或无法确认的路径" };
  }
  if (MEMORY_READ.has(name)) return { safe: true, planSafe: true, reason: "查询记忆或定时任务" };
  if (name === "scratchpad" && ["read", "status"].includes(String(input.action))) return { safe: true, planSafe: true, reason: "读取临时记忆" };
  if (SAFE_OFFICE.has(name)) return { safe: true, planSafe: false, reason: "在受管理目录中创建独立办公产物" };
  if (name === "bash" || name === "powershell") return { safe: false, planSafe: false, reason: "运行系统命令，可能修改文件、访问网络或启动其他程序" };
  if (name === "edit" || name === "write") return { safe: false, planSafe: false, reason: "修改或覆盖文件内容" };
  // A readOnlyHint is an extension author's assertion, not an OS sandbox.
  if (tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true) return { safe: true, planSafe: true, reason: "工具声明为只读" };
  return { safe: false, planSafe: false, reason: "扩展或 MCP 工具可能改变外部状态" };
}

/** Adapted from Pi's MIT permission-gate / plan-mode examples, using the existing Web UI bridge. */
export function createWorkAgentPolicyExtension(agentDir = getAgentDir()): InlineExtension {
  return {
    name: "workagent-execution-policy", hidden: true,
    factory(pi) {
      pi.on("before_agent_start", (event) => {
        const mode = readPolicy(agentDir).mode;
        const instruction = mode === "plan"
          ? "当前为计划模式：只分析和制定方案，不写文件、不执行命令、不创建产物、不修改记忆或定时任务。不要重复尝试被策略拒绝的工具。子代理同样只读。"
          : mode === "review"
            ? "当前为安全审查模式：系统命令、文件修改和未声明只读的外部工具将在执行前请求人类批准。被拒绝后停止该操作，不要换工具绕过审批。"
            : "当前为默认放行模式：工具调用不逐次请求批准，仍须遵守用户任务范围和工具自身的路径约束。";
        return { systemPrompt: `${event.systemPrompt}\n\n[WorkAgent 执行策略]\n${instruction}` };
      });
      pi.on("tool_call", async (event, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        const result = await authorizeWorkAgentAction({
          agentDir, sessionId, toolName: event.toolName,
          tool: pi.getAllTools().find(candidate => candidate.name === event.toolName),
          input: event.input, cwd: ctx.cwd,
          hasUI: ctx.hasUI,
          confirm: (title, message, opts) => ctx.ui.confirm(title, message, opts),
          signal: ctx.signal,
        });
        if (!result.allowed) return { block: true, reason: `执行策略已阻止：${result.reason}。如需执行，请由用户在界面切换模式或批准本次操作。` };
      });
    },
  };
}
