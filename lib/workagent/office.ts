import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { runBoundedProcess } from "./process";
import { describeArtifact, ensureWorkspace, OfficeError, projectRoot, resolveInputFile, validateWorkspace, type OfficeArtifact } from "./workspace";

export type OfficeOperation = "inventory" | "reconcile" | "report";
export interface OfficeRequest {
  operation: OfficeOperation;
  inputs?: string[];
  options?: Record<string, unknown>;
}
export interface OfficeResult {
  ok: true;
  operation: OfficeOperation;
  summary: string;
  artifacts: OfficeArtifact[];
  details: Record<string, unknown>;
  validation?: unknown;
}

export function parseOfficeRequest(body: unknown): OfficeRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new OfficeError("INVALID_REQUEST", "请求必须是 JSON 对象");
  const value = body as Record<string, unknown>;
  if (!["inventory", "reconcile", "report"].includes(String(value.operation))) throw new OfficeError("INVALID_OPERATION", "不支持的办公操作");
  if (value.inputs !== undefined && (!Array.isArray(value.inputs) || value.inputs.length > 20 || value.inputs.some((input) => typeof input !== "string" || input.length > 1000))) {
    throw new OfficeError("INVALID_INPUTS", "inputs 必须为不超过 20 个工作区相对文件路径");
  }
  if (value.options !== undefined && (!value.options || typeof value.options !== "object" || Array.isArray(value.options))) throw new OfficeError("INVALID_OPTIONS", "options 必须是对象");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 65_536) throw new OfficeError("REQUEST_TOO_LARGE", "办公请求超过大小限制", 413);
  return { operation: value.operation as OfficeOperation, inputs: value.inputs as string[] | undefined, options: value.options as Record<string, unknown> | undefined };
}

/** Both the HTTP route and Pi extension use this broker, keeping execution and file validation identical. */
export async function executeOffice(body: unknown, context: { root?: string; cwd?: string; signal?: AbortSignal } = {}): Promise<OfficeResult> {
  const request = parseOfficeRequest(body);
  const root = projectRoot(context.root);
  const workspace = await ensureWorkspace(root);
  const cwd = await validateWorkspace(context.cwd ?? workspace.cwd, root);
  let requestedInputs = request.inputs;
  if (requestedInputs === undefined && request.operation === "reconcile") requestedInputs = workspace.exampleInputs.slice(0, 2);
  if (request.operation === "inventory" && (requestedInputs?.length ?? 0) > 1) throw new OfficeError("INVALID_INPUTS", "文件清单只接受一个待扫描目录");
  const inputs = await Promise.all((requestedInputs ?? []).map((input) => resolveInputFile(input, cwd, request.operation === "inventory")));
  const options = { ...request.options };
  if (request.operation === "inventory" && options.directory !== undefined) {
    if (typeof options.directory !== "string") throw new OfficeError("INVALID_OPTIONS", "options.directory 必须是工作区内相对目录");
    options.directory = await resolveInputFile(options.directory, cwd, true);
  }
  if (request.operation === "reconcile" && inputs.length !== 2) throw new OfficeError("INVALID_INPUTS", "表格核对需要两份输入文件");
  const outputDir = path.join(workspace.outputDir, `${request.operation}-${randomUUID()}`);
  await mkdir(outputDir);
  const processResult = await runBoundedProcess("uv", ["run", "python", "-m", "workers.office"], {
    cwd: root,
    input: JSON.stringify({ operation: request.operation, workspace: cwd, outputDir, inputs, options }),
    signal: context.signal,
  });
  let result: Record<string, unknown>;
  try { result = JSON.parse(processResult.stdout.trim()); }
  catch { throw new OfficeError("WORKER_PROTOCOL", `办公执行器未返回有效 JSON（退出码 ${processResult.exitCode}）${processResult.stderr ? `：${processResult.stderr.slice(-1200)}` : ""}`, 502); }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new OfficeError("WORKER_PROTOCOL", "办公执行器返回无效结果", 502);
  if (processResult.exitCode !== 0 || result.ok !== true) {
    const error = result.error;
    const message = typeof error === "string" ? error : error && typeof error === "object" && "message" in error ? String(error.message) : "办公处理失败";
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "WORKER_FAILED";
    throw new OfficeError(code, message, 422);
  }
  if (!Array.isArray(result.artifacts) || result.artifacts.length > 100) throw new OfficeError("WORKER_PROTOCOL", "办公执行器缺少有效产物清单", 502);
  const artifacts = await Promise.all(result.artifacts.map(async (artifact: unknown) => {
    if (!artifact || typeof artifact !== "object" || !("path" in artifact) || typeof artifact.path !== "string") throw new OfficeError("WORKER_PROTOCOL", "产物缺少路径", 502);
    return describeArtifact(artifact.path, outputDir);
  }));
  return {
    ok: true, operation: request.operation,
    summary: typeof result.summary === "string" ? result.summary : "办公处理完成",
    artifacts, details: { ...(result.details && typeof result.details === "object" && !Array.isArray(result.details) ? result.details as Record<string, unknown> : {}), exampleInputsUsed: request.operation === "reconcile" && request.inputs === undefined },
    ...(result.validation === undefined ? {} : { validation: result.validation }),
  };
}

let readiness: { checkedAt: number; result: Promise<{ officeReady: boolean; officeError?: string }> } | undefined;
export function officeReadiness(root = process.cwd()) {
  if (!readiness || Date.now() - readiness.checkedAt > 30_000) {
    readiness = { checkedAt: Date.now(), result: runBoundedProcess("uv", ["run", "python", "-c", "from workers.office.worker import run_request; import openpyxl; import docx"], { cwd: root, timeoutMs: 30_000, maxOutputBytes: 65_536 })
      .then((result) => result.exitCode === 0 ? { officeReady: true } : { officeReady: false, officeError: result.stderr.slice(-1200) || "Python 办公依赖尚未就绪" })
      .catch((error: unknown) => ({ officeReady: false, officeError: error instanceof Error ? error.message : String(error) })) };
  }
  return readiness.result;
}
