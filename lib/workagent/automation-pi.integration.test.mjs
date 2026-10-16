import assert from "node:assert/strict";
import { access, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { createWorkAgentRoutinesExtension, createScheduledTask } = await jiti.import("./automation.ts");
const { createWorkAgentPolicyExtension, writePolicyMode } = await jiti.import("./policy.ts");
// The next cron poll is at least one second away. A 250ms idle timeout would
// evict the owner before delivery unless the real liveness protocol preserves it.
process.env.PI_WEB_IDLE_TIMEOUT_MS = "250";
const { AgentSessionWrapper } = await jiti.import("../rpc-manager.ts");

test("native scheduled delivery enters a real Pi model loop and persists its reply", { timeout: 15_000 }, async t => {
  const root = await mkdtemp(path.join(process.cwd(), ".workagent-scheduled-pi-"));
  const cwd = path.join(root, ".workagent/workspace");
  const agentDir = path.join(root, ".workagent/agent");
  let wrapper;
  t.after(async () => {
    await wrapper?.shutdown();
    assert.equal(path.dirname(root), process.cwd());
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(cwd, ".workagent"), { recursive: true });
  await mkdir(path.join(root, "resources/workagent-office"), { recursive: true });
  await mkdir(path.join(root, "examples/office"), { recursive: true });
  await copyFile(path.resolve("resources/workagent-office/SKILL.md"), path.join(root, "resources/workagent-office/SKILL.md"));
  writePolicyMode("review", agentDir);
  const faux = fauxProvider({ models: [{ id: "scheduled-pi-fixture" }] });
  faux.setResponses([fauxAssistantMessage(fauxText("SCHEDULED_PI_COMPLETED"))]);
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [createWorkAgentPolicyExtension(agentDir), await createWorkAgentRoutinesExtension(agentDir, root)],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const sessionManager = SessionManager.create(cwd, path.join(agentDir, "sessions"));
  const { session } = await createAgentSession({
    cwd, agentDir, modelRuntime, model: faux.getModel("scheduled-pi-fixture"), settingsManager, resourceLoader, sessionManager,
  });
  await createScheduledTask({ name: "real-pi-delivery", schedule: "*/1 * * * * *", prompt: "SCHEDULED_PI_INPUT", recurring: false }, root);
  wrapper = new AgentSessionWrapper(session);
  wrapper.start();
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  const until = Date.now() + 8_000;
  while (Date.now() < until && !session.messages.some(message => message.role === "assistant")) await delay(50);
  await session.waitForIdle();
  assert.equal(faux.state.callCount, 1, "the due task must actually call the isolated Pi provider");
  assert.equal(session.getLastAssistantText(), "SCHEDULED_PI_COMPLETED");
  assert.ok(session.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("SCHEDULED_PI_INPUT")));
  const sessionFile = sessionManager.getSessionFile();
  assert.ok(sessionFile);
  await wrapper.shutdown();
  const restored = SessionManager.open(sessionFile).buildSessionContext().messages;
  assert.ok(restored.some(message => message.role === "assistant" && JSON.stringify(message.content).includes("SCHEDULED_PI_COMPLETED")));
  await assert.rejects(access(path.join(cwd, ".workagent/scheduled_tasks.lock")), { code: "ENOENT" });
});
