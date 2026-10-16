import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

// This scripted provider exists only in tests. It makes no network requests and is never
// registered in the product's models.json, credentials, or default model configuration.
const root = fileURLToPath(new URL("../../", import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { ensureWorkspace } = await jiti.import("./workspace.ts");

async function setup(t, fauxOptions = {}) {
  const fixtureRoot = path.join(root, ".workagent", "test-fixtures");
  await mkdir(fixtureRoot, { recursive: true });
  const agentDir = await mkdtemp(path.join(fixtureRoot, "pi-runtime-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    assert.equal(path.dirname(path.resolve(agentDir)), path.resolve(fixtureRoot));
    await rm(agentDir, { recursive: true, force: true });
  });
  const workspace = await ensureWorkspace(root);
  const faux = fauxProvider({ provider: "workagent-test-fixture", models: [{ id: "office-scripted-fixture" }], ...fauxOptions });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory();
  // Trust only this in-memory test settings object; no user trust store is read or written.
  settingsManager.setProjectTrusted(true);
  const resourceLoader = new DefaultResourceLoader({ cwd: workspace.cwd, agentDir, settingsManager, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const sessionManager = SessionManager.create(workspace.cwd, path.join(agentDir, "sessions"));
  const { session } = await createAgentSession({ cwd: workspace.cwd, agentDir, modelRuntime, model: faux.getModel("office-scripted-fixture"), sessionManager, settingsManager, resourceLoader });
  t.after(() => session.dispose());
  await session.bindExtensions({});
  return { session, sessionManager, faux, workspace };
}

test("real Pi loop calls the office extension, runs uv worker, settles, and restores JSONL history", { timeout: 60_000 }, async (t) => {
  const { session, sessionManager, faux, workspace } = await setup(t);
  const events = [];
  session.subscribe((event) => events.push(event));
  let declaredTools = [];
  faux.setResponses([
    (context) => {
      declaredTools = getCurrentTools(context.messages).map((tool) => tool.name);
      return fauxAssistantMessage(fauxToolCall("office_reconcile", { inputs: workspace.exampleInputs.slice(0, 2), options: { key: "编号" } }, { id: "office-reconcile-integration" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage(fauxText("测试模型：已收到真实办公工具返回的差异文件。")),
  ]);
  await session.prompt("测试模型 fixture：核对两份内置 CSV，并把工具产物交付给我。");
  await session.waitForIdle();
  assert.ok(declaredTools.includes("office_reconcile"));
  assert.equal(faux.state.callCount, 2);
  const result = session.messages.find((message) => message.role === "toolResult" && message.toolCallId === "office-reconcile-integration");
  assert.ok(result, "Pi must record the real tool result");
  assert.notEqual(result.isError, true);
  assert.equal(result.details.ok, true);
  assert.equal(result.details.operation, "reconcile");
  assert.equal(result.details.artifacts.length, 3);
  for (const artifact of result.details.artifacts) {
    assert.ok((await stat(artifact.path)).size > 0);
    assert.ok(path.relative(workspace.outputDir, artifact.path).startsWith("reconcile-"));
  }
  assert.ok(events.some((event) => event.type === "tool_execution_start" && event.toolName === "office_reconcile"));
  assert.ok(events.some((event) => event.type === "tool_execution_end" && event.toolName === "office_reconcile"));
  assert.ok(events.some((event) => event.type === "agent_settled"));
  assert.match(session.getLastAssistantText(), /真实办公工具/);

  const sessionFile = sessionManager.getSessionFile();
  assert.ok(sessionFile);
  session.dispose();
  const persisted = await readFile(sessionFile, "utf8");
  assert.match(persisted, /office-reconcile-integration/);
  const restored = SessionManager.open(sessionFile);
  const messages = restored.buildSessionContext().messages;
  assert.equal(restored.getCwd(), workspace.cwd);
  assert.ok(messages.some((message) => message.role === "user"));
  const restoredResult = messages.find((message) => message.role === "toolResult" && message.toolCallId === "office-reconcile-integration");
  assert.equal(restoredResult.details.artifacts.length, 3);
  assert.match(messages.filter((message) => message.role === "assistant").at(-1).content.filter((block) => block.type === "text").map((block) => block.text).join(""), /真实办公工具/);
});

test("Pi abort stops streaming from the test model and persists an aborted turn", { timeout: 15_000 }, async (t) => {
  const { session, sessionManager, faux } = await setup(t, { tokensPerSecond: 50, tokenSize: { min: 1, max: 1 } });
  faux.setResponses([fauxAssistantMessage(fauxText("可中断的测试回复。".repeat(200)))]);
  let abortPromise;
  session.subscribe((event) => {
    if (!abortPromise && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") abortPromise = session.abort();
  });
  await session.prompt("测试模型 fixture：开始输出，以验证停止。");
  assert.ok(abortPromise, "The test must interrupt an actual streamed reply");
  await abortPromise;
  await session.waitForIdle();
  assert.equal(session.isStreaming, false);
  const lastAssistant = session.messages.filter((message) => message.role === "assistant").at(-1);
  assert.equal(lastAssistant.stopReason, "aborted");
  const restored = SessionManager.open(sessionManager.getSessionFile());
  assert.equal(restored.buildSessionContext().messages.filter((message) => message.role === "assistant").at(-1).stopReason, "aborted");
});
