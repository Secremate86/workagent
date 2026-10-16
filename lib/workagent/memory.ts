import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import { serializeByKey } from "../key-serializer";
import { assertExecutionMutationAllowed } from "./policy";
import { OfficeError } from "./workspace";

const ENTRY_MARKER = /<!-- workagent-memory:([0-9a-f-]{36}) -->/g;
const MAX_FILE_BYTES = 128_000;
const MAX_DAILY_FILES = 30;
const MAX_ENTRIES = 100;
const MAX_CONTEXT_CHARS = 12_000;
const MAX_WRITE_CHARS = 8_000;
const MEMORY_LOCK = Symbol.for("pi-web.workagent-memory-lock");

function isDateKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}

export function workAgentMemoryDir(root = process.cwd()) {
  return path.join(path.resolve(root), ".workagent", "memory");
}

function storagePaths(root = process.cwd()) {
  const dir = workAgentMemoryDir(root);
  return { root: path.resolve(root), parent: path.dirname(dir), dir, daily: path.join(dir, "daily"), recovery: path.join(dir, "recovery"), longTerm: path.join(dir, "MEMORY.md"), scratchpad: path.join(dir, "SCRATCHPAD.md") };
}

async function verifyPathTree(root: string, create: boolean) {
  const paths = storagePaths(root);
  const realRoot = await realpath(paths.root).catch(() => { throw new OfficeError("MEMORY_ROOT_INVALID", "项目目录不可访问", 403); });
  if (realRoot !== paths.root) throw new OfficeError("MEMORY_ROOT_INVALID", "项目目录不能通过符号链接访问", 403);
  for (const directory of [paths.parent, paths.dir, paths.daily, paths.recovery]) {
    try {
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new OfficeError("MEMORY_PATH_DENIED", "记忆目录不能是符号链接或非目录", 403);
      const actual = await realpath(directory);
      if (actual !== directory && !actual.startsWith(`${paths.root}${path.sep}`)) throw new OfficeError("MEMORY_PATH_DENIED", "记忆目录超出项目范围", 403);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) continue;
      await mkdir(directory);
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new OfficeError("MEMORY_PATH_DENIED", "记忆目录创建后校验失败", 403);
    }
  }
  for (const file of [paths.longTerm, paths.scratchpad]) await verifyManagedFile(file, paths.dir);
  for (const directory of [paths.daily, paths.recovery]) {
    try {
      const names = await readdir(directory);
      if (names.length > 500) throw new OfficeError("MEMORY_TOO_MANY_FILES", "记忆文件数量超过安全上限", 413);
      for (const name of names) {
        if (directory === paths.daily && !/^\d{4}-\d\d-\d\d\.md$/.test(name)) continue;
        if (directory === paths.recovery && !/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
        await verifyManagedFile(path.join(directory, name), directory);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return paths;
}

async function verifyManagedFile(file: string, parent: string) {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new OfficeError("MEMORY_FILE_INVALID", "记忆文件不能是符号链接或非普通文件", 403);
    const sizeLimit = parent.endsWith(`${path.sep}recovery`) ? 512_000 : MAX_FILE_BYTES;
    if (info.size > sizeLimit) throw new OfficeError("MEMORY_FILE_TOO_LARGE", "记忆文件超过读取上限", 413);
    if (path.dirname(await realpath(file)) !== parent) throw new OfficeError("MEMORY_PATH_DENIED", "记忆文件超出管理目录", 403);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

async function safeText(file: string) {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new OfficeError("MEMORY_FILE_INVALID", "记忆文件不是普通文件", 403);
    if (info.size > MAX_FILE_BYTES) throw new OfficeError("MEMORY_FILE_TOO_LARGE", "记忆文件超过读取上限", 413);
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function assertAppendFits(existing: string, added: string, overwrite = false) {
  const bytes = Buffer.byteLength(overwrite ? added : `${existing}${existing.trim() ? "\n\n" : ""}${added}`, "utf8") + 128;
  if (bytes > MAX_FILE_BYTES) throw new OfficeError("MEMORY_FILE_TOO_LARGE", "写入后记忆文件会超过 128 KB 上限", 413);
}

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function markerEntries(content: string, target: string) {
  const lines = content.split(/\r?\n/);
  const result: Array<{ id: string; content: string }> = [];
  let block: string[] = [];
  const flush = () => {
    const text = block.join("\n").trim();
    const match = ENTRY_MARKER.exec(text);
    ENTRY_MARKER.lastIndex = 0;
    if (match) result.push({ id: match[1], content: text.replace(ENTRY_MARKER, "").replace(/^<!-- (?:last updated: )?\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \[[^\]]+\] -->\s*/, "").trim() });
    block = [];
  };
  for (const line of lines) {
    if (/^<!-- \d{4}-\d\d-\d\d \d\d:\d\d:\d\d \[[^\]]+\] -->$/.test(line)) { flush(); block = [line]; }
    else block.push(line);
  }
  flush();
  return result.map((entry) => ({ ...entry, target }));
}

export interface MemorySnapshot {
  status: { storage: "ready" | "empty"; search: "disabled" };
  files: { longTerm: string; scratchpad: string; daily: Array<{ date: string; content: string }> };
  entries: Array<{ id: string; target: string; date?: string; content: string }>;
  truncated?: boolean;
}

/** Read-only snapshot. Missing storage remains missing; GET never creates it. */
export async function memorySnapshot(root = process.cwd()): Promise<MemorySnapshot> {
  const p = await verifyPathTree(root, false);
  const longTerm = await safeText(p.longTerm);
  const scratchpad = await safeText(p.scratchpad);
  let daily: Array<{ date: string; content: string }> = [];
  let dailyTruncated = false;
  try {
    const allNames = (await readdir(p.daily)).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name) && isDateKey(name.slice(0, 10))).sort().reverse();
    dailyTruncated = allNames.length > MAX_DAILY_FILES;
    const names = allNames.slice(0, MAX_DAILY_FILES);
    daily = await Promise.all(names.map(async (name) => ({ date: name.slice(0, 10), content: await safeText(path.join(p.daily, name)) })));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const allEntries = markerEntries(longTerm, "long_term").concat(...daily.map((item) => markerEntries(item.content, "daily").map((entry) => ({ ...entry, date: item.date }))));
  let entryBudget = 24_000;
  const entries = allEntries.slice(0, MAX_ENTRIES).map((entry) => {
    const content = entry.content.slice(0, Math.min(8_000, entryBudget));
    entryBudget -= content.length;
    return { ...entry, content };
  }).filter((entry) => entry.content);
  let budget = MAX_CONTEXT_CHARS;
  let truncated = false;
  const cap = (value: string) => { if (value.length <= budget) { budget -= value.length; return value; } truncated = true; const next = value.slice(0, Math.max(0, budget)); budget = 0; return next; };
  const cappedLong = cap(longTerm), cappedScratch = cap(scratchpad);
  const cappedDaily = daily.map((item) => ({ ...item, content: cap(item.content) })).filter((item) => item.content || daily.some((d) => d.date === item.date && d.content === ""));
  const empty = !longTerm.trim() && !scratchpad.trim() && !dailyTruncated && daily.every((item) => !item.content.trim());
  truncated ||= dailyTruncated || allEntries.length > MAX_ENTRIES || entries.length < Math.min(allEntries.length, MAX_ENTRIES);
  return { status: { storage: empty ? "empty" : "ready", search: "disabled" }, files: { longTerm: cappedLong, scratchpad: cappedScratch, daily: cappedDaily }, entries, ...(truncated ? { truncated: true } : {}) };
}

const nativeToolsByRoot = new Map<string, Promise<Map<string, ToolDefinition>>>();
async function nativeTools(root = process.cwd()) {
  const resolvedRoot = path.resolve(root);
  let pending = nativeToolsByRoot.get(resolvedRoot);
  if (!pending) {
    const dir = workAgentMemoryDir(resolvedRoot);
    process.env.PI_MEMORY_DIR = workAgentMemoryDir();
    process.env.PI_MEMORY_EXIT_SUMMARY = "0";
    process.env.PI_MEMORY_SUMMARIZE_TRANSITIONS = "0";
    process.env.PI_MEMORY_QMD_UPDATE = "off";
    process.env.PI_MEMORY_NO_SEARCH = "1";
    pending = (async () => {
      const piMemoryPackageJson = process.getBuiltinModule("node:module").createRequire(path.join(process.cwd(), "package.json")).resolve("pi-memory/package.json");
      const piMemoryPath = path.join(path.dirname(piMemoryPackageJson), "index.ts");
      const jiti = createJiti(piMemoryPackageJson, { moduleCache: false, interopDefault: true });
      const mod = jiti(piMemoryPath) as { default: (pi: ExtensionAPI) => void | Promise<void>; _setBaseDir: (dir: string) => void };
      mod._setBaseDir(dir);
      const captured = new Map<string, ToolDefinition>();
      const facade = new Proxy({}, { get: (_target, key) => key === "registerTool" ? (tool: ToolDefinition) => captured.set(tool.name, tool) : key === "on" ? () => undefined : () => undefined }) as ExtensionAPI;
      await mod.default(facade);
      return captured;
    })();
    nativeToolsByRoot.set(resolvedRoot, pending);
  }
  return pending;
}

function assertRequestText(content: unknown): asserts content is string {
  if (typeof content !== "string" || !content.trim() || content.length > MAX_WRITE_CHARS || /\0/.test(content)) throw new OfficeError("INVALID_MEMORY_CONTENT", `记忆内容必须为 1 至 ${MAX_WRITE_CHARS} 个字符`, 400);
}

/** Adds an explicit, deletable user-approved long-term fact via pi-memory's native writer. */
export async function addMemory(content: unknown, root = process.cwd(), agentDir?: string) {
  assertRequestText(content);
  assertExecutionMutationAllowed(agentDir);
  const p = await verifyPathTree(root, true);
  const tools = await nativeTools(root);
  const tool = tools.get("memory_write");
  if (!tool) throw new OfficeError("MEMORY_PLUGIN_INVALID", "pi-memory 未注册 memory_write", 500);
  const id = randomUUID();
  const ctx = { sessionManager: { getSessionId: () => "workagent-web" } } as Parameters<ToolDefinition["execute"]>[4];
  await serializeByKey(MEMORY_LOCK, path.resolve(root), async () => {
    assertExecutionMutationAllowed(agentDir);
    await verifyPathTree(root, true);
    const existing = await safeText(p.longTerm);
    assertAppendFits(existing, `<!-- ${localDateKey()} 00:00:00 [workagen] -->\n<!-- workagent-memory:${id} -->\n${content.trim()}`);
    assertExecutionMutationAllowed(agentDir);
    await tool.execute(`memory-web-${id}`, { target: "long_term", content: `<!-- workagent-memory:${id} -->\n${content.trim()}`, mode: "append" }, new AbortController().signal, () => undefined, ctx);
  });
  await verifyPathTree(root, false);
  if (!(await safeText(p.longTerm)).includes(id)) throw new OfficeError("MEMORY_WRITE_FAILED", "记忆未能写入存储", 409);
  return { id, target: "long_term" as const };
}

export async function deleteMemory(id: unknown, root = process.cwd(), target: "long_term" | "daily" = "long_term", date?: string, agentDir?: string) {
  assertExecutionMutationAllowed(agentDir);
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) throw new OfficeError("INVALID_MEMORY_ID", "记忆条目标识无效", 400);
  if (target === "daily" && (!date || !isDateKey(date))) throw new OfficeError("INVALID_MEMORY_DATE", "删除 daily 条目需要有效日期", 400);
  const p = await verifyPathTree(root, false);
  const file = target === "daily" ? path.join(p.daily, `${date}.md`) : p.longTerm;
  const current = await safeText(file);
  if (!markerEntries(current, target).some((entry) => entry.id === id)) throw new OfficeError("MEMORY_ENTRY_NOT_FOUND", "找不到可删除的记忆条目", 404);
  const tools = await nativeTools(root);
  const tool = tools.get("memory_forget");
  if (!tool) throw new OfficeError("MEMORY_PLUGIN_INVALID", "pi-memory 未注册 memory_forget", 500);
  const ctx = { sessionManager: { getSessionId: () => "workagent-web" } } as Parameters<ToolDefinition["execute"]>[4];
  const result = await serializeByKey(MEMORY_LOCK, path.resolve(root), async () => {
    await verifyPathTree(root, false);
    assertExecutionMutationAllowed(agentDir);
    return tool.execute(`memory-web-delete-${id}`, { target, ...(date ? { date } : {}), match: `<!-- workagent-memory:${id} -->` }, new AbortController().signal, () => undefined, ctx);
  });
  await verifyPathTree(root, false);
  if (!(result.details as { removed?: number } | undefined)?.removed || (await safeText(file)).includes(`<!-- workagent-memory:${id} -->`)) throw new OfficeError("MEMORY_DELETE_FAILED", "记忆插件没有删除目标条目", 409);
}

/** Wraps the real pi-memory factory, discarding implicit lifecycle hooks and replacing unsafe reads/search. */
export async function createWorkAgentMemoryExtension(agentDir?: string, storageRoot = process.cwd()): Promise<InlineExtension> {
  const root = path.resolve(storageRoot);
  const native = await nativeTools(root);
  const allowed = new Set(["memory_write", "memory_forget", "memory_read", "memory_search", "memory_status"]);
  const selected = [...native.values()].filter((tool) => allowed.has(tool.name));
  return {
    name: "workagent-memory",
    factory: (pi) => {
      pi.on("before_agent_start", async (event) => {
        const snapshot = await memorySnapshot(root);
        const sections = [snapshot.files.longTerm.trim() && `## Long-term memory\n\n${snapshot.files.longTerm}`, snapshot.files.scratchpad.trim() && `## Scratchpad\n\n${snapshot.files.scratchpad}`, ...snapshot.files.daily.map((item) => item.content.trim() && `## Daily ${item.date}\n\n${item.content}`)].filter(Boolean);
        if (!sections.length) return;
        return { systemPrompt: `${event.systemPrompt}\n\n## Explicit WorkAgent memory\nUse these saved user-approved facts as context; do not infer new memories from conversation.\n\n${sections.join("\n\n")}` };
      });
      for (const tool of selected) {
        if (tool.name === "memory_read" || tool.name === "memory_search" || tool.name === "memory_status") {
          pi.registerTool({ ...tool, execute: async (_id, params) => {
            const snapshot = await memorySnapshot(root);
            if (tool.name === "memory_search") return { content: [{ type: "text", text: "Memory search is disabled; use memory_read to inspect the explicit memory files." }], details: { search: "disabled" } };
            if (tool.name === "memory_status") return { content: [{ type: "text", text: `Storage: ${snapshot.status.storage}; search: disabled.` }], details: snapshot.status };
            const target = (params as { target?: string }).target;
            const date = (params as { date?: string }).date;
            const now = new Date();
            const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
            if (target === "list") return { content: [{ type: "text", text: snapshot.files.daily.length ? snapshot.files.daily.map((item) => `- ${item.date}.md`).join("\n") : "No daily logs found." }], details: { files: snapshot.files.daily.map((item) => `${item.date}.md`) } };
            const text = target === "scratchpad" ? snapshot.files.scratchpad : target === "daily" ? snapshot.files.daily.find((item) => item.date === (date ?? localDate))?.content ?? "" : snapshot.files.longTerm;
            return { content: [{ type: "text", text: text || "No memory stored." }], details: {} };
          } });
          continue;
        }
        if (tool.name === "memory_write") {
          pi.registerTool({ ...tool, description: "Save a memory only when the user explicitly asks you to remember or save that preference, fact, or decision. Never infer durable memories from ordinary conversation and never summarize or auto-save chats. Do not overwrite existing memory unless the user explicitly asks to replace it.", execute: async (...args) => {
            return serializeByKey(MEMORY_LOCK, path.resolve(root), async () => {
              assertExecutionMutationAllowed(agentDir);
              await verifyPathTree(root, true);
              const params = args[1] as Record<string, unknown>;
              assertRequestText(params.content);
              const target = params.target === "daily" ? "daily" : "long_term";
              const file = target === "daily" ? path.join(storagePaths(root).daily, `${localDateKey()}.md`) : storagePaths(root).longTerm;
              const existing = await safeText(file);
              const tagged = typeof params.content === "string" && !ENTRY_MARKER.test(params.content) ? `<!-- workagent-memory:${randomUUID()} -->\n${params.content.trim()}` : params.content as string;
              ENTRY_MARKER.lastIndex = 0;
              const stamp = `<!-- ${localDateKey()} 00:00:00 [workagen] -->\n${tagged}`;
              assertAppendFits(existing, stamp, target === "long_term" && params.mode === "overwrite");
              args[1] = { ...params, content: tagged };
              assertExecutionMutationAllowed(agentDir);
              if (args[2]?.aborted) throw new OfficeError("CANCELLED", "记忆操作已取消", 499);
              const result = await tool.execute(...args);
              await verifyPathTree(root, false);
              return result;
            });
          } });
          continue;
        }
        if (tool.name === "memory_forget") {
          pi.registerTool({ ...tool, description: "Remove saved memories only when the user explicitly asks to forget, delete, or correct a stored fact. Keep the recovery ID from the native recovery record available in the tool result.", execute: async (...args) => {
            return serializeByKey(MEMORY_LOCK, path.resolve(root), async () => {
              assertExecutionMutationAllowed(agentDir);
              await verifyPathTree(root, true);
              assertExecutionMutationAllowed(agentDir);
              if (args[2]?.aborted) throw new OfficeError("CANCELLED", "记忆操作已取消", 499);
              const result = await tool.execute(...args);
              await verifyPathTree(root, false);
              return result;
            });
          } });
          continue;
        }
      }
    },
  };
}
