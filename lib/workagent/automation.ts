import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { assertExecutionMutationAllowed, readPolicy, type ExecutionMode } from "./policy";
import { subscribePolicyMode } from "./policy-events";
import { registerSessionLivenessProvider } from "../session-liveness";
import { ensureWorkspace, validateWorkspace, workspacePath, OfficeError } from "./workspace";

type Task = { id: string; name: string; schedule: string; prompt: string; type: "durable" | "session"; createdAt: string; lastRunAt?: string; nextRunAt?: string; recurring: boolean; maxAgeDays: number; sessionId?: string };
type Scheduler = { start(): void; stop(): void; getStore(): Store };
type Store = {
  addTask(task: Task): void; generateId(): string; getDurableTasks(): Task[]; getAllTasks(): Task[]; getSessionTasks(): Task[];
  removeTask(id: string): boolean; getTask(id: string): Task | undefined; refreshNextRun(id: string, after?: Date): void;
  updateTask(id: string, updates: Partial<Task>): boolean; pruneExpired(): Task[];
};
type CronModule = { CronScheduler: new (options: { cwd: string; sessionId: string; onFire(task: Task): void; onError(error: Error): void }) => Scheduler };
type StoreModule = { CronTaskStore: new (cwd: string) => Store };
type CronFns = { parseCron(schedule: string): unknown; computeNextCronRun(schedule: string, after?: Date): Date | null };
type NativeToolFactory = (pi: ExtensionAPI, getScheduler: () => Scheduler | null, getSessionId: () => string) => void;
type Runtime = { status: "active" | "offline" | "plan" | "error"; ownerSessionId?: string; error?: string; delivery: "active-session-only"; timeZone: string };
type Owner = { sessionId: string; scheduler: Scheduler; api: ExtensionAPI; agentDir: string; mode: ExecutionMode; status: Runtime["status"]; error?: string; unsubscribe?: () => void };

// Resolve against the installed runtime packages. Webpack cannot statically
// parse a computed createRequire argument and otherwise replaces it with void.
const requireFromProject = process.getBuiltinModule("node:module").createRequire(path.join(process.cwd(), "package.json"));
const packageJson = requireFromProject.resolve("pi-routines/package.json");
const routinesRoot = path.dirname(packageJson);
const jitiPath = path.join(path.dirname(requireFromProject.resolve("jiti")), "jiti.mjs");
type NativeBundle = { CronScheduler: CronModule["CronScheduler"]; CronTaskStore: StoreModule["CronTaskStore"]; parseCron: CronFns["parseCron"]; computeNextCronRun: CronFns["computeNextCronRun"]; register: NativeToolFactory[] };
let loaded: Promise<NativeBundle> | undefined;
async function native(): Promise<NativeBundle> {
  loaded ??= (async () => {
    const jitiModule = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ pathToFileURL(jitiPath).href) as { createJiti: typeof import("jiti").createJiti };
    // The native store and lock hardcode their config folder. Adapt only these
    // two constructors while retaining the installed scheduler and locking logic.
    const baseTransform = jitiModule.createJiti(packageJson, { fsCache: false }).transform;
    const jiti = jitiModule.createJiti(packageJson, {
      interopDefault: true, moduleCache: false, fsCache: false,
      transform(options) {
        const file = options.filename && path.resolve(options.filename);
        const adapted = ["cronTasks.ts", "cronTasksLock.ts"].some(name => file === path.join(routinesRoot, "src", name));
        let source = options.source;
        if (adapted) {
          const original = 'path.join(cwd, \".pi\",';
          if (!source.includes(original)) throw new Error("定时任务存储适配契约发生变化，请检查依赖版本");
          source = source.replace(original, 'path.join(cwd, \".workagent\",');
        }
        return { code: baseTransform({ ...options, source }) };
      },
    });
    const [scheduler, tasks, cron, create, list, del] = await Promise.all([
      jiti.import<CronModule>(path.join(routinesRoot, "src/cronScheduler.ts")),
      jiti.import<StoreModule>(path.join(routinesRoot, "src/cronTasks.ts")),
      jiti.import<CronFns>(path.join(routinesRoot, "src/cron.ts")),
      jiti.import<{ registerCronCreateTool: NativeToolFactory }>(path.join(routinesRoot, "src/tools/cronCreate.ts")),
      jiti.import<{ registerCronListTool: NativeToolFactory }>(path.join(routinesRoot, "src/tools/cronList.ts")),
      jiti.import<{ registerCronDeleteTool: NativeToolFactory }>(path.join(routinesRoot, "src/tools/cronDelete.ts")),
    ]);
    return { CronScheduler: scheduler.CronScheduler, CronTaskStore: tasks.CronTaskStore, parseCron: cron.parseCron, computeNextCronRun: cron.computeNextCronRun, register: [create.registerCronCreateTool, list.registerCronListTool, del.registerCronDeleteTool] };
  })();
  return loaded;
}

const globalState = globalThis as typeof globalThis & { __workAgentRoutineOwners?: Map<string, Map<string, Owner>>; __workAgentRoutineErrors?: Map<string, string> };
const owners = globalState.__workAgentRoutineOwners ??= new Map();
const runtimeErrors = globalState.__workAgentRoutineErrors ??= new Map();
const canon = (cwd: string) => process.platform === "win32" ? path.resolve(cwd).toLowerCase() : path.resolve(cwd);
function taskFile(cwd: string) { return path.join(cwd, ".workagent", "scheduled_tasks.json"); }
function checkPiTree(cwd: string) {
  const piDir = path.join(cwd, ".workagent");
  let piStat;
  try { piStat = lstatSync(piDir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (piStat.isSymbolicLink() || !piStat.isDirectory() || realpathSync(piDir) !== piDir) throw new OfficeError("SCHEDULE_PATH_DENIED", "定时任务目录不能是符号链接或指向工作区外", 403);
  const lock = path.join(piDir, "scheduled_tasks.lock");
  try {
    const info = lstatSync(lock);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 4096 || path.dirname(realpathSync(lock)) !== piDir) throw new OfficeError("SCHEDULE_PATH_DENIED", "调度锁文件必须是工作区内普通文件", 403);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function checkTaskStore(cwd: string) {
  checkPiTree(cwd);
  const file = taskFile(cwd);
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 2_000_000 || path.dirname(realpathSync(file)) !== path.join(cwd, ".workagent")) throw new OfficeError("SCHEDULE_PATH_DENIED", "定时任务文件必须是工作区内的普通文件且不超过 2 MB", 403);
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1 || !Array.isArray((parsed as { tasks?: unknown }).tasks)) throw new Error("invalid task store");
    const tasks = (parsed as { tasks: unknown[] }).tasks;
    if (tasks.length > 500 || tasks.some((raw) => {
      if (!raw || typeof raw !== "object") return true;
      const task = raw as Task;
      return typeof task.id !== "string" || !/^task_[a-zA-Z0-9_-]{8,100}$/.test(task.id)
        || typeof task.schedule !== "string" || task.schedule.length > 120
        || typeof task.prompt !== "string" || task.prompt.length > 4000
        || typeof task.name !== "string" || !task.name.trim() || task.name.length > 120
        || task.type !== "durable" || typeof task.recurring !== "boolean"
        || !Number.isInteger(task.maxAgeDays) || task.maxAgeDays < 0 || task.maxAgeDays > 3650
        || typeof task.createdAt !== "string" || !Number.isFinite(Date.parse(task.createdAt));
    })) throw new Error("invalid task entries");
    return tasks as Task[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    if (error instanceof OfficeError) throw error;
    throw new OfficeError("SCHEDULE_STORE_CORRUPT", "定时任务文件损坏，已停止读取和修改以避免覆盖数据", 500);
  }
}

function computeValidatedNext(schedule: string, mod: NativeBundle) {
  const fieldsText = schedule.trim().split(/\s+/);
  if (fieldsText.length !== 5 && fieldsText.length !== 6) throw new OfficeError("INVALID_CRON", "cron 表达式必须包含 5 或 6 个字段", 400);
  const validAtom = (value: string) => value === "*" || /^\d+$/.test(value) || /^[a-z]{3}$/i.test(value);
  for (const field of fieldsText) {
    for (const segment of field.split(",")) {
      const [range, step, ...extra] = segment.split("/");
      const ends = range.split("-");
      if (extra.length || (step !== undefined && !/^\d+$/.test(step)) || ends.length > 2 || ends.some((value) => !validAtom(value))) {
        throw new OfficeError("INVALID_CRON", "cron 表达式包含无效字段", 400);
      }
    }
  }
  const fields = mod.parseCron(schedule) as Record<string, unknown>;
  if (!Object.values(fields).every((values) => Array.isArray(values) && values.length > 0)) throw new OfficeError("INVALID_CRON", "cron 表达式包含无效或空字段", 400);
  const next = mod.computeNextCronRun(schedule, new Date());
  if (!next) throw new OfficeError("INVALID_CRON", "cron 表达式没有可计算的下一次运行时间", 400);
  return next;
}

function validateNewTask(task: Task, cwd: string, mod: NativeBundle) {
  if (!task.name.trim() || task.name.length > 120 || !task.prompt.trim() || task.prompt.length > 4000 || task.schedule.length > 120 || !Number.isInteger(task.maxAgeDays) || task.maxAgeDays < 0 || task.maxAgeDays > 3650 || !task.nextRunAt || !Number.isFinite(Date.parse(task.nextRunAt))) {
    throw new OfficeError("INVALID_TASK", "定时任务字段无效或超出长度限制", 400);
  }
  computeValidatedNext(task.schedule, mod);
  const tasks = checkTaskStore(cwd);
  if (tasks.length >= 500) throw new OfficeError("SCHEDULE_LIMIT", "定时任务数量已达到 500 条上限", 413);
  const projected = Buffer.byteLength(JSON.stringify({ version: 1, tasks: [...tasks, task] }, null, 2), "utf8");
  if (projected > 2_000_000) throw new OfficeError("SCHEDULE_SIZE_LIMIT", "定时任务文件最多 2 MB", 413);
}

export async function scheduleSnapshot(root = process.cwd()) {
  const expected = workspacePath(root);
  try { lstatSync(expected); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const mode = readPolicy(path.join(root, ".workagent", "agent")).mode;
      return { tasks: [], total: 0, truncated: false, runtime: { status: mode === "plan" ? "plan" : "offline", delivery: "active-session-only", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } as Runtime };
    }
    throw error;
  }
  const cwd = await validateWorkspace(expected, root);
  const all = checkTaskStore(cwd);
  const lockPath = path.join(cwd, ".workagent", "scheduled_tasks.lock");
  let lock: { pid: number; sessionId: string } | undefined;
  try { lock = JSON.parse(readFileSync(lockPath, "utf8")) as typeof lock; } catch { /* no live owner */ }
  let ownerAlive = false;
  if (lock && Number.isInteger(lock.pid) && typeof lock.sessionId === "string") { try { process.kill(lock.pid, 0); ownerAlive = true; } catch { ownerAlive = false; } }
  const error = runtimeErrors.get(canon(cwd));
  const candidate = lock && owners.get(canon(cwd))?.get(lock.sessionId);
  const ownedHere = ownerAlive && lock?.pid === process.pid && Boolean(candidate) && candidate?.status !== "error";
  const externalLock = ownerAlive && !ownedHere;
  const runtime: Runtime = ownedHere && lock
    ? { status: "active", ownerSessionId: lock.sessionId, delivery: "active-session-only", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
    : { status: error || externalLock ? "error" : readPolicy(path.join(root, ".workagent", "agent")).mode === "plan" ? "plan" : "offline", ...((error || externalLock) ? { error: error ?? "调度锁由本应用之外的进程持有，未确认其执行策略" } : {}), delivery: "active-session-only", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  return { tasks: all.slice(0, 100), total: all.length, limit: 100, truncated: all.length > 100, runtime };
}

export async function createScheduledTask(input: unknown, root = process.cwd()) {
  assertExecutionMutationAllowed(path.join(root, ".workagent", "agent"));
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new OfficeError("INVALID_REQUEST", "请求必须是 JSON 对象", 400);
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["name", "schedule", "prompt", "recurring", "maxAgeDays"].includes(key))) throw new OfficeError("INVALID_REQUEST", "请求包含不支持的字段", 400);
  if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 120 || typeof body.schedule !== "string" || body.schedule.length > 120 || typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 4000) throw new OfficeError("INVALID_REQUEST", "名称、cron 表达式或提示内容无效", 400);
  if (body.recurring !== undefined && typeof body.recurring !== "boolean") throw new OfficeError("INVALID_REQUEST", "recurring 必须是布尔值", 400);
  const recurring = body.recurring ?? true;
  const maxAgeDays = body.maxAgeDays ?? 7;
  if (typeof maxAgeDays !== "number" || !Number.isInteger(maxAgeDays) || maxAgeDays < 0 || maxAgeDays > 3650) throw new OfficeError("INVALID_REQUEST", "maxAgeDays 必须为 0 至 3650 的整数", 400);
  const cwd = await validateWorkspace((await ensureWorkspace(root)).cwd, root);
  const mod = await native();
  let nextRun: Date;
  try { nextRun = computeValidatedNext(body.schedule, mod); } catch (error) { if (error instanceof OfficeError) throw error; throw new OfficeError("INVALID_CRON", `cron 表达式无效：${error instanceof Error ? error.message : String(error)}`, 400); }
  assertExecutionMutationAllowed(path.join(root, ".workagent", "agent"));
  checkTaskStore(cwd);
  const store = new mod.CronTaskStore(cwd);
  const now = new Date();
  const task: Task = { id: store.generateId(), name: body.name.trim(), schedule: body.schedule, prompt: body.prompt.trim(), type: "durable", createdAt: now.toISOString(), recurring, maxAgeDays: recurring ? maxAgeDays : 0, nextRunAt: nextRun.toISOString() };
  validateNewTask(task, cwd, mod);
  store.addTask(task);
  return { task, runtime: (await scheduleSnapshot(root)).runtime };
}

export async function deleteScheduledTask(id: unknown, root = process.cwd()) {
  assertExecutionMutationAllowed(path.join(root, ".workagent", "agent"));
  if (typeof id !== "string" || !/^task_[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new OfficeError("INVALID_TASK_ID", "定时任务标识无效", 400);
  const cwd = await validateWorkspace((await ensureWorkspace(root)).cwd, root);
  const tasks = checkTaskStore(cwd);
  if (!tasks.some((task) => task.id === id)) throw new OfficeError("TASK_NOT_FOUND", "找不到该定时任务", 404);
  assertExecutionMutationAllowed(path.join(root, ".workagent", "agent"));
  const store = new (await native()).CronTaskStore(cwd);
  if (!store.removeTask(id)) throw new OfficeError("TASK_NOT_FOUND", "找不到该定时任务", 404);
  return { deletedId: id, runtime: (await scheduleSnapshot(root)).runtime };
}

export async function createWorkAgentRoutinesExtension(agentDir?: string, root = process.cwd()): Promise<InlineExtension> {
  const mod = await native();
  const managedAgentDir = path.resolve(agentDir ?? path.join(root, ".workagent", "agent"));
  return {
    name: "workagent-routines",
    factory(pi) {
      let scheduler: Scheduler | null = null;
      let sessionId = "";
      let workspace = "";
      let owner: Owner | undefined;
      let unsubscribe: (() => void) | undefined;
      let releaseLiveness: (() => void) | undefined;
      const stop = () => {
        if (!owner) { scheduler = null; return; }
        try { owner.scheduler.stop(); } catch (error) { owner.status = "error"; owner.error = error instanceof Error ? error.message : String(error); }
        const key = canon(workspace);
        const group = owners.get(key);
        group?.delete(owner.sessionId);
        if (group?.size === 0) owners.delete(key);
        owner = undefined; scheduler = null;
      };
      const start = async (mode: ExecutionMode) => {
        if (!workspace || !sessionId) { stop(); return; }
        if (mode === "plan") { stop(); runtimeErrors.delete(canon(workspace)); return; }
        if (owner && owners.get(canon(workspace))?.get(sessionId) === owner) return;
        stop();
        try {
          checkTaskStore(workspace);
          const activeScheduler = new mod.CronScheduler({ cwd: workspace, sessionId, onFire(task: Task) {
            if (readPolicy(managedAgentDir).mode === "plan") return;
            pi.sendUserMessage(task.prompt, { deliverAs: "followUp" });
          }, onError(error: Error) { runtimeErrors.set(canon(workspace), error.message); if (owner) { owner.status = "error"; owner.error = error.message; } } });
          scheduler = activeScheduler;
          owner = { sessionId, scheduler: activeScheduler, api: pi, agentDir: managedAgentDir, mode, status: "active" };
          const group = owners.get(canon(workspace)) ?? new Map<string, Owner>();
          group.set(sessionId, owner);
          owners.set(canon(workspace), group);
          runtimeErrors.delete(canon(workspace));
          const store = activeScheduler.getStore();
          const dynamicStore = store as unknown as Record<string, (...args: unknown[]) => unknown>;
          const assertSafeRead = () => {
            checkTaskStore(workspace);
            if (readPolicy(managedAgentDir).mode === "plan") return false;
            return true;
          };
          for (const method of ["getAllTasks", "getDurableTasks", "getSessionTasks", "getTask"] as const) {
            const original = dynamicStore[method].bind(store);
            dynamicStore[method] = (...args) => assertSafeRead() ? original(...args) : (method === "getTask" ? undefined : []);
          }
          for (const method of ["addTask", "removeTask", "updateTask", "refreshNextRun", "pruneExpired"] as const) {
            const original = dynamicStore[method].bind(store);
            dynamicStore[method] = (...args) => {
              checkTaskStore(workspace);
              assertExecutionMutationAllowed(managedAgentDir);
              if (method === "addTask") validateNewTask(args[0] as Task, workspace, mod);
              return original(...args);
            };
          }
          activeScheduler.start();
        } catch (error) {
          runtimeErrors.set(canon(workspace), error instanceof Error ? error.message : String(error));
          if (owner) { owner.status = "error"; owner.error = error instanceof Error ? error.message : String(error); }
          scheduler?.stop(); scheduler = null;
          const group = owners.get(canon(workspace));
          if (owner) group?.delete(owner.sessionId);
          if (group?.size === 0) owners.delete(canon(workspace));
          owner = undefined;
        }
      };
      const captured = new Map<string, ToolDefinition>();
      const facade = new Proxy({}, { get: (_target, key) => key === "registerTool" ? (tool: ToolDefinition) => { captured.set(tool.name, tool); } : key === "on" ? () => undefined : () => undefined }) as ExtensionAPI;
      for (const register of mod.register) register(facade, () => scheduler, () => sessionId);
      for (const [name, tool] of captured) {
        pi.registerTool({ ...tool, execute: async (...args) => {
          if ((name === "cron_create" || name === "cron_delete") && scheduler) assertExecutionMutationAllowed(managedAgentDir);
          if (name !== "cron_list" && !scheduler) throw new Error("当前没有可投递的活动 WorkAgent 会话；请稍后重试");
          if (workspace) checkTaskStore(workspace);
          return tool.execute(...args);
        } });
      }
      pi.on("session_start", async (_event, ctx) => {
        sessionId = ctx.sessionManager.getSessionId();
        try { workspace = await validateWorkspace(ctx.cwd, root); }
        catch (error) {
          if (error instanceof OfficeError && error.code === "PATH_DENIED") return;
          throw error;
        }
        const mode = readPolicy(managedAgentDir).mode;
        releaseLiveness?.();
        releaseLiveness = registerSessionLivenessProvider({
          name: "workagent-routines", sessionId,
          isActive: () => {
            try {
              return Boolean(scheduler && owner?.status !== "error"
                && readPolicy(managedAgentDir).mode !== "plan"
                && scheduler.getStore().getAllTasks().length > 0);
            } catch { return false; }
          },
        });
        unsubscribe = subscribePolicyMode(managedAgentDir, (next) => { void start(next); });
        if (owner) owner.unsubscribe = unsubscribe;
        await start(mode);
      });
      pi.on("session_shutdown", () => {
        unsubscribe?.(); unsubscribe = undefined;
        releaseLiveness?.(); releaseLiveness = undefined;
        stop();
      });
    },
  };
}
