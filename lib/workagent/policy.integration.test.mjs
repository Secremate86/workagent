import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper } = await jiti.import("../rpc-manager.ts");
const { ensureWorkAgentPolicySession } = await jiti.import("../rpc-manager.ts");
const { authorizeWorkAgentAction, createWorkAgentPolicyExtension, readPolicy, WORKAGENT_POLICY_VERSION, writePolicyMode } = await jiti.import("./policy.ts");

async function startFixture(t, mode = "review", extraFactories = [], includePolicy = true) {
  const fixtureRoot = await mkdtemp(join(process.cwd(), ".workagent-policy-fixture-"));
  const agentDir = join(fixtureRoot, "agent");
  const cwd = join(fixtureRoot, "cwd");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(agentDir);
  await mkdir(cwd);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  writePolicyMode(mode, agentDir);
  const faux = fauxProvider({ models: [{ id: "faux-workagent-policy" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({});
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    extensionFactories: [...(includePolicy ? [createWorkAgentPolicyExtension(agentDir)] : []), ...extraFactories],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const sessionManager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd, agentDir, modelRuntime, model: faux.getModel("faux-workagent-policy"),
    sessionManager, settingsManager, resourceLoader,
  });
  const wrapper = new AgentSessionWrapper(session);
  wrapper.start();
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  t.after(async () => {
    wrapper.destroy();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(fixtureRoot, { recursive: true, force: true });
  });
  return { agentDir, cwd, faux, session, wrapper };
}

test("an idle wrapper created before the policy extension is rebuilt before its next command", async (t) => {
  const { cwd, wrapper } = await startFixture(t, "review", [], false);
  assert.equal(wrapper.inner.extensionRunner.getExtensionPaths().includes("<inline:workagent-execution-policy>"), false);
  const replacement = await ensureWorkAgentPolicySession(wrapper.sessionId, wrapper);
  assert.notEqual(replacement, wrapper);
  assert.equal(replacement.inner.extensionRunner.getExtensionPaths().includes("<inline:workagent-execution-policy>"), true);
  assert.equal(replacement.cwd, cwd);
  await replacement.shutdown();
});

test("a wrapper with an older policy implementation is rebuilt even when its extension path matches", async (t) => {
  const { wrapper } = await startFixture(t);
  assert.equal(wrapper.inner.extensionRunner.getExtensionPaths().includes("<inline:workagent-execution-policy>"), true);
  wrapper.workAgentPolicyVersion = "2026-10-16-v1";
  const replacement = await ensureWorkAgentPolicySession(wrapper.sessionId, wrapper);
  assert.notEqual(replacement, wrapper);
  assert.equal(replacement.workAgentPolicyVersion, WORKAGENT_POLICY_VERSION);
  await replacement.shutdown();
});

test("an active wrapper with stale policy returns 409 without being interrupted", async (t) => {
  const { wrapper } = await startFixture(t);
  wrapper.workAgentPolicyVersion = "2026-10-16-v1";
  wrapper.pendingPromptCount = 1;
  await assert.rejects(ensureWorkAgentPolicySession(wrapper.sessionId, wrapper), (error) => error.status === 409);
  assert.equal(wrapper.isAlive(), true);
  wrapper.pendingPromptCount = 0;
});

test("review refuses an unsafe action when no UI is available", async (t) => {
  const { agentDir, cwd } = await startFixture(t);
  const marker = join(cwd, "headless-marker.txt");
  const result = await authorizeWorkAgentAction({
    agentDir, sessionId: "headless-fixture", toolName: "write",
    input: { path: marker, content: "must not exist" }, cwd, hasUI: false,
  });
  assert.equal(result.allowed, false);
  assert.equal(await access(marker).then(() => true, () => false), false);
  assert.ok(readPolicy(agentDir).audit.some((entry) => entry.toolName === "write" && entry.decision === "denied"));
});

function answerNextApproval(wrapper, confirmed) {
  let request;
  const seen = new Promise((resolve) => {
    const unsubscribe = wrapper.onEvent((event) => {
      if (event.type !== "extension_ui_request" || event.method !== "confirm") return;
      unsubscribe();
      request = event;
      resolve(event);
    });
  });
  return {
    seen,
    answer: async (value = confirmed) => {
      const current = request ?? await seen;
      return wrapper.send({ type: "extension_ui_response", id: current.id, confirmed: value });
    },
  };
}

function scheduleWrite(faux, marker) {
  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall("write", { path: marker, content: "approved marker" }, { id: "policy-write" })], { stopReason: "toolUse" }),
    () => fauxAssistantMessage([fauxText("done")]),
  ]);
}

test("review executes a marker write only after the Web approval response", async (t) => {
  const { agentDir, cwd, faux, session, wrapper } = await startFixture(t);
  const marker = join(cwd, "approval-marker.txt");
  scheduleWrite(faux, marker);
  const approval = answerNextApproval(wrapper, true);
  const run = session.prompt("write marker");
  const request = await approval.seen;
  assert.equal(request.title, "高风险操作审批");
  assert.equal(request.timeout, 120_000);
  assert.equal(await access(marker).then(() => true, () => false), false);
  let replayed;
  const stopListening = wrapper.onEvent((event) => {
    if (event.type === "extension_ui_request" && event.id === request.id) replayed = event;
  });
  assert.equal(replayed?.id, request.id, "an SSE reconnect gets the still-pending approval request");
  stopListening();
  await approval.answer();
  await run;
  assert.equal(await readFile(marker, "utf8"), "approved marker");
  assert.ok(readPolicy(agentDir).audit.some((entry) => entry.toolName === "write" && entry.decision === "allowed"));
});

test("review denial leaves the marker absent", async (t) => {
  const { cwd, faux, session, wrapper } = await startFixture(t);
  const marker = join(cwd, "denied-marker.txt");
  scheduleWrite(faux, marker);
  const approval = answerNextApproval(wrapper, false);
  const run = session.prompt("write marker");
  await approval.seen;
  await approval.answer();
  await run;
  assert.equal(await access(marker).then(() => true, () => false), false);
});

test("Stop cancels a pending approval and leaves the marker absent", async (t) => {
  const { cwd, faux, session, wrapper } = await startFixture(t);
  const marker = join(cwd, "cancelled-marker.txt");
  scheduleWrite(faux, marker);
  const approval = answerNextApproval(wrapper, true);
  const run = session.prompt("write marker");
  await approval.seen;
  await wrapper.send({ type: "abort" });
  await run;
  assert.equal(await access(marker).then(() => true, () => false), false);
});

test("the Web approval bridge timeout rejects the call without execution", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { cwd, faux, session, wrapper } = await startFixture(t);
  const marker = join(cwd, "timeout-marker.txt");
  scheduleWrite(faux, marker);
  const approval = answerNextApproval(wrapper, true);
  const run = session.prompt("write marker");
  const request = await approval.seen;
  assert.equal(request.timeout, 120_000);
  t.mock.timers.tick(120_000);
  await run;
  assert.equal(await access(marker).then(() => true, () => false), false);
});

test("changing review to auto while approval is pending does not authorize that call", async (t) => {
  const { agentDir, cwd, faux, session, wrapper } = await startFixture(t);
  const marker = join(cwd, "stale-approval-marker.txt");
  scheduleWrite(faux, marker);
  const approval = answerNextApproval(wrapper, true);
  const run = session.prompt("write marker");
  await approval.seen;
  writePolicyMode("auto", agentDir);
  await approval.answer();
  await run;
  assert.equal(await access(marker).then(() => true, () => false), false);
  assert.ok(readPolicy(agentDir).audit.some((entry) => entry.toolName === "write" && entry.decision === "denied"));
});

test("switching to plan while approval is pending rejects the old call", async (t) => {
  const { agentDir, cwd, faux, session, wrapper } = await startFixture(t);
  const marker = join(cwd, "plan-switch-marker.txt");
  scheduleWrite(faux, marker);
  const approval = answerNextApproval(wrapper, true);
  const run = session.prompt("write marker");
  await approval.seen;
  writePolicyMode("plan", agentDir);
  await approval.answer();
  await run;
  assert.equal(await access(marker).then(() => true, () => false), false);
});

test("plan blocks a marker write and auto runs it without opening approval UI", async (t) => {
  const plan = await startFixture(t, "plan");
  const planMarker = join(plan.cwd, "plan-marker.txt");
  scheduleWrite(plan.faux, planMarker);
  let approvalRequested = false;
  plan.wrapper.onEvent((event) => { if (event.type === "extension_ui_request" && event.method === "confirm") approvalRequested = true; });
  await plan.session.prompt("write marker");
  assert.equal(await access(planMarker).then(() => true, () => false), false);
  assert.equal(approvalRequested, false);
  assert.ok(readPolicy(plan.agentDir).audit.some((entry) => entry.toolName === "write" && entry.decision === "blocked"));

  const automatic = await startFixture(t, "auto");
  const autoMarker = join(automatic.cwd, "auto-marker.txt");
  scheduleWrite(automatic.faux, autoMarker);
  let autoApprovalRequested = false;
  automatic.wrapper.onEvent((event) => { if (event.type === "extension_ui_request" && event.method === "confirm") autoApprovalRequested = true; });
  await automatic.session.prompt("write marker");
  assert.equal(await readFile(autoMarker, "utf8"), "approved marker");
  assert.equal(autoApprovalRequested, false);
  assert.ok(readPolicy(automatic.agentDir).audit.some((entry) => entry.toolName === "write" && entry.decision === "auto"));
});

test("the policy hook also intercepts a write started by a nested extension tool", async (t) => {
  const { agentDir, cwd, faux, session, wrapper } = await startFixture(t, "review", [{
    name: "nested-policy-writer",
    factory(pi) {
      pi.registerTool({
        name: "nested_writer", label: "Nested writer", description: "Write through a nested tool call", parameters: Type.Object({ path: Type.String() }),
        annotations: { readOnlyHint: true },
        async execute(_id, params, signal, _update, ctx) {
          return ctx.executeTool("write", { path: params.path, content: "nested marker" }, { signal });
        },
      });
    },
  }]);
  const marker = join(cwd, "nested-marker.txt");
  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall("nested_writer", { path: marker }, { id: "policy-nested-write" })], { stopReason: "toolUse" }),
    () => fauxAssistantMessage([fauxText("done")]),
  ]);
  const approval = answerNextApproval(wrapper, true);
  const run = session.prompt("write through nested tool");
  await approval.seen;
  await approval.answer();
  await run;
  assert.equal(await readFile(marker, "utf8"), "nested marker");
  assert.ok(readPolicy(agentDir).audit.some((entry) => entry.toolName === "write" && entry.decision === "allowed"));
});
