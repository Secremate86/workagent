import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper } = await jiti.import("../rpc-manager.ts");
const { createSubagentController } = await jiti.import("../subagent-runtime.ts");
const { createWorkAgentPolicyExtension, readPolicy, writePolicyMode } = await jiti.import("./policy.ts");

const withTimeout = (promise, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 15_000);
  promise.then(resolve, reject).finally(() => clearTimeout(timer));
});

async function fixture(t, mode) {
  const root = await mkdtemp(join(tmpdir(), "workagent-subagent-policy-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "cwd");
  await import("node:fs/promises").then(({ mkdir }) => Promise.all([mkdir(agentDir), mkdir(cwd), mkdir(join(agentDir, "agents"))]));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  writePolicyMode(mode, agentDir);
  await writeFile(join(agentDir, "agents", "fixture.md"), [
    "---", "description: Policy integration fixture.", "tools: read, write", "load_skills: false", "load_extensions: false", "max_turns: 1", "---", "Complete the task.",
  ].join("\n"));
  const faux = fauxProvider({ models: [{ id: "subagent-policy-faux" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({});
  const services = await createAgentSessionServices({
    cwd, agentDir, modelRuntime, settingsManager,
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
  });
  const { session: parentInner } = await createAgentSessionFromServices({
    services, sessionManager: SessionManager.create(cwd, join(root, "parent-sessions")), model: faux.getModel("subagent-policy-faux"),
  });
  const wrappers = new Map();
  const register = (inner) => {
    const wrapper = new AgentSessionWrapper(inner, { suppressCompletionNotifications: true });
    wrappers.set(inner.sessionId, wrapper);
    wrapper.start();
    wrapper.beginExtensionBinding();
    return wrapper;
  };
  const parent = register(parentInner);
  await parent.waitUntilReady();
  const controller = createSubagentController({
    getSession: (id) => wrappers.get(id), registerSession: register,
    resolveSessionPath: async (id) => wrappers.get(id)?.sessionFile ?? null,
    reopenSession: async (id, sessionFile) => {
      const childServices = await createAgentSessionServices({
        cwd, agentDir, modelRuntime, settingsManager,
        resourceLoaderOptions: {
          extensionFactories: [createWorkAgentPolicyExtension(agentDir)],
          noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        },
      });
      const childManager = SessionManager.open(sessionFile);
      const { session } = await createAgentSessionFromServices({
        services: childServices, sessionManager: childManager, model: faux.getModel("subagent-policy-faux"),
      });
      assert.equal(session.sessionId, id);
      return register(session);
    },
    invalidateSessionList() {}, isBuiltInSubagentsEnabled: () => true,
  });
  const request = {
    parentContext: { sessionManager: parentInner.sessionManager }, parentToolCallId: "policy-fixture-call",
    profile: "fixture", task: "Apply the requested file operation.", description: "Policy fixture", runInBackground: false,
  };
  t.after(async () => {
    for (const wrapper of wrappers.values()) wrapper.destroy();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });
  return { root, agentDir, cwd, faux, parent, parentInner, wrappers, controller, request };
}

function planWrite(faux, marker, text = "done") {
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("write", { path: marker, content: "must not reach disk" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText(text)]),
  ]);
}

test("a real plan-mode subagent blocks writes on spawn and resume", async (t) => {
  const f = await fixture(t, "plan");
  const marker = join(f.cwd, "plan-child-marker.txt");
  planWrite(f.faux, marker, "PLAN_DONE");
  const started = await f.controller.extensionRuntime.start(f.request);
  const first = await withTimeout(started.completion, "initial child completion");
  assert.equal(first.status, "completed");
  assert.equal(first.result, "PLAN_DONE");
  assert.equal(await access(marker).then(() => true, () => false), false);

  const childWrapper = f.wrappers.get(first.sessionId);
  childWrapper.destroy();
  planWrite(f.faux, marker, "RESUMED_DONE");
  const resumed = await f.controller.extensionRuntime.resume({ ...f.request, sessionId: first.sessionId, task: "Continue and write the marker." });
  const second = await withTimeout(resumed.completion, "resumed child completion");
  assert.equal(second.status, "completed");
  assert.equal(await access(marker).then(() => true, () => false), false);
  const audit = readPolicy(f.agentDir).audit.filter((entry) => entry.toolName === "write");
  assert.equal(audit.length, 2);
  assert.ok(audit.every((entry) => entry.decision === "blocked"));
});

function nextApproval(wrapper) {
  let request;
  const seen = new Promise((resolve) => {
    const off = wrapper.onEvent((event) => {
      if (event.type !== "extension_ui_request" || event.method !== "confirm") return;
      request = event;
      off();
      resolve(event);
    });
  });
  return { seen, answer: async (confirmed) => {
    const current = request ?? await seen;
    return wrapper.send({ type: "extension_ui_response", id: current.id, confirmed });
  } };
}

test("a real review-mode child waits for approval; denial blocks and approval writes", async (t) => {
  const f = await fixture(t, "review");
  for (const confirmed of [false, true]) {
    const marker = join(f.cwd, `${confirmed ? "approved" : "denied"}-child-marker.txt`);
    f.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: marker, content: confirmed ? "approved" : "denied" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("child finished")]),
    ]);
    const started = await f.controller.extensionRuntime.start(f.request);
    const child = f.wrappers.get(started.run.sessionId);
    const approval = nextApproval(child);
    const completion = withTimeout(started.completion, "child approval run");
    await withTimeout(approval.seen, "child approval request");
    assert.equal(await access(marker).then(() => true, () => false), false);
    await approval.answer(confirmed);
    await completion;
    assert.equal(await access(marker).then(() => true, () => false), confirmed);
    if (confirmed) assert.equal(await readFile(marker, "utf8"), "approved");
  }
});
