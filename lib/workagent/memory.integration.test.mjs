import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const memory = await jiti.import("./memory.ts");
const policy = await jiti.import("./policy.ts");

async function tempRoot(t, prefix = ".workagent-memory-fixture-") {
  const root = await mkdtemp(join(process.cwd(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("GET is read-only and does not create memory directories", async (t) => {
  const root = await tempRoot(t);
  const snapshot = await memory.memorySnapshot(root);
  assert.deepEqual(snapshot.status, { storage: "empty", search: "disabled" });
  await assert.rejects(lstat(memory.workAgentMemoryDir(root)), { code: "ENOENT" });
});

test("pi-memory native writer format is retained and per-root instances do not cross-write", async (t) => {
  const rootA = await tempRoot(t, ".workagent-memory-a-");
  const rootB = await tempRoot(t, ".workagent-memory-b-");
  const agentDirA = join(rootA, "agent"), agentDirB = join(rootB, "agent");
  await mkdir(agentDirA); await mkdir(agentDirB);
  policy.writePolicyMode("review", agentDirA); policy.writePolicyMode("review", agentDirB);
  const a = await memory.addMemory("用户偏好：中文回复。", rootA, agentDirA);
  const b = await memory.addMemory("决策：报告使用 Markdown。", rootB, agentDirB);
  const fileA = join(memory.workAgentMemoryDir(rootA), "MEMORY.md");
  const fileB = join(memory.workAgentMemoryDir(rootB), "MEMORY.md");
  const textA = await readFile(fileA, "utf8");
  const textB = await readFile(fileB, "utf8");
  assert.match(textA, /^<!-- \d{4}-\d\d-\d\d \d\d:\d\d:\d\d \[workagen\] -->/);
  assert.match(textA, new RegExp(`<!-- workagent-memory:${a.id} -->`));
  assert.match(textB, new RegExp(`<!-- workagent-memory:${b.id} -->`));
  assert.doesNotMatch(textA, new RegExp(b.id));
  assert.doesNotMatch(textB, new RegExp(a.id));
  const reference = await memory.addMemory(`保留这条对 ${a.id} 的文本引用。`, rootA, agentDirA);
  await memory.deleteMemory(a.id, rootA, "long_term", undefined, agentDirA);
  const remaining = await readFile(fileA, "utf8");
  assert.ok(remaining.includes(reference.id), "deleting one entry must preserve another entry referring to its id");
  assert.ok(!remaining.includes(`<!-- workagent-memory:${a.id} -->`));
  const recovery = await readdir(join(memory.workAgentMemoryDir(rootA), "recovery"));
  assert.equal(recovery.length, 1, "native memory_forget recovery record remains available");
});

test("memory service appends, reopens, lists, deletes long-term and daily markers, and blocks plan writes", async (t) => {
  const root = await tempRoot(t);
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  policy.writePolicyMode("review", agentDir);
  const created = await memory.addMemory("偏好：先给结论，再说明依据。", root, agentDir);
  const snapshot = await memory.memorySnapshot(root);
  assert.ok(snapshot.entries.some((entry) => entry.id === created.id && entry.content.includes("先给结论")));
  const reopened = await memory.memorySnapshot(root);
  assert.ok(reopened.files.longTerm.includes("先给结论"));
  await memory.deleteMemory(created.id, root, "long_term", undefined, agentDir);
  assert.equal((await memory.memorySnapshot(root)).entries.some((entry) => entry.id === created.id), false);
  const now = new Date();
  const dailyDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const dailyId = "a19b06ad-990c-438f-82b1-a315da3cd827";
  const dailyFile = join(memory.workAgentMemoryDir(root), "daily", `${dailyDate}.md`);
  await writeFile(dailyFile, `<!-- ${dailyDate} 12:00:00 [workagen] -->\n<!-- workagent-memory:${dailyId} -->\n当日事实：交付测试。\n`);
  const dailySnapshot = await memory.memorySnapshot(root);
  assert.ok(dailySnapshot.entries.some((entry) => entry.id === dailyId && entry.target === "daily" && entry.date === dailyDate));
  await memory.deleteMemory(dailyId, root, "daily", dailyDate, agentDir);
  assert.doesNotMatch(await readFile(dailyFile, "utf8"), new RegExp(dailyId));
  policy.writePolicyMode("plan", agentDir);
  await assert.rejects(memory.addMemory("plan不能保存", root, agentDir), (error) => error.status === 403);
});

test("real Pi session injects saved memory, plan blocks native writes, and lifecycle adds no implicit files", async (t) => {
  const root = await tempRoot(t);
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  await memory.addMemory("持久事实：该用户偏好简洁中文。", root, agentDir);
  policy.writePolicyMode("plan", agentDir);
  const faux = fauxProvider({ models: [{ id: "faux-workagent-memory" }] });
  let capturedPrompt = "";
  faux.setResponses([
    (context) => { capturedPrompt = getCurrentSystemPrompt(context.messages); return fauxAssistantMessage([fauxToolCall("memory_write", { target: "long_term", content: "plan应阻止该写入" })], { stopReason: "toolUse" }); },
    () => fauxAssistantMessage([fauxText("已检查记忆策略。")]),
  ]);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({});
  const extension = await memory.createWorkAgentMemoryExtension(agentDir, root);
  let hookPrompt = "";
  const observer = { name: "memory-fixture-observer", factory(pi) { pi.on("before_agent_start", (event) => { hookPrompt = event.systemPrompt; }); } };
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, extensionFactories: [policy.createWorkAgentPolicyExtension(agentDir), extension, observer], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  const sessionManager = SessionManager.inMemory(root);
  const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, model: faux.getModel("faux-workagent-memory"), sessionManager, settingsManager, resourceLoader });
  await session.prompt("请分析已保存的偏好，然后尝试保存一条新的长期记忆。");
  await session.dispose();
  assert.match(hookPrompt, /该用户偏好简洁中文/);
  assert.match(capturedPrompt, /该用户偏好简洁中文/);
  const final = await memory.memorySnapshot(root);
  assert.doesNotMatch(final.files.longTerm, /plan应阻止该写入/);
  assert.equal(final.files.daily.length, 0);
  assert.equal(await access(join(memory.workAgentMemoryDir(root), "recovery")).then(() => true, () => false), true);
  assert.deepEqual(await readdir(join(memory.workAgentMemoryDir(root), "recovery")), []);
});

test("memory paths reject symlinks that escape the project", async (t) => {
  const root = await tempRoot(t);
  const outside = await tempRoot(t, ".workagent-memory-outside-");
  const data = join(root, ".workagent");
  await symlink(outside, data, "junction");
  await assert.rejects(memory.addMemory("拒绝越界写", root), (error) => error.code === "MEMORY_PATH_DENIED");
});

test("memory files reject symlinks before read or mutation", async (t) => {
  const root = await tempRoot(t);
  const outside = await tempRoot(t, ".workagent-memory-file-outside-");
  const memoryDir = memory.workAgentMemoryDir(root);
  await mkdir(memoryDir, { recursive: true });
  await symlink(outside, join(memoryDir, "MEMORY.md"), "junction");
  await assert.rejects(memory.memorySnapshot(root), (error) => error.code === "MEMORY_FILE_INVALID");
  await assert.rejects(memory.addMemory("不应跟随文件链接", root), (error) => error.code === "MEMORY_FILE_INVALID");
});
