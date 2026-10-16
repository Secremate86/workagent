import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const automation = await jiti.import("./automation.ts");
const policy = await jiti.import("./policy.ts");
const workspaceModule = await jiti.import("./workspace.ts");
const { hasActiveSessionLivenessProvider } = await jiti.import("../session-liveness.ts");

async function fixture(t) {
  const root = await mkdtemp(path.join(process.cwd(), ".workagent-routines-fixture-"));
  await mkdir(path.join(root, "resources", "workagent-office"), { recursive: true });
  await mkdir(path.join(root, "examples", "office"), { recursive: true });
  await copyFile(path.join(process.cwd(), "resources", "workagent-office", "SKILL.md"), path.join(root, "resources", "workagent-office", "SKILL.md"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("native routines tools load and API task storage survives a new store instance", async (t) => {
  const root = await fixture(t);
  const extension = await automation.createWorkAgentRoutinesExtension(path.join(root, ".workagent", "agent"));
  const names = [];
  const handlers = new Map();
  extension.factory({
    registerTool(tool) { names.push(tool.name); },
    on(event, handler) { handlers.set(event, handler); },
  });
  assert.deepEqual(names.sort(), ["cron_create", "cron_delete", "cron_list"]);
  assert.equal(handlers.has("session_start"), true);
  assert.equal(handlers.has("session_shutdown"), true);

  const result = await automation.createScheduledTask({ name: "quick check", schedule: "*/5 * * * * *", prompt: "check this" }, root);
  assert.equal(result.task.type, "durable");
  assert.equal(result.runtime.status, "offline");
  const snapshot = await automation.scheduleSnapshot(root);
  assert.equal(snapshot.total, 1);
  assert.equal(snapshot.tasks[0].id, result.task.id);
  const durable = JSON.parse(await readFile(path.join(root, ".workagent", "workspace", ".workagent", "scheduled_tasks.json"), "utf8"));
  assert.equal(durable.version, 1);
  assert.equal(durable.tasks[0].prompt, "check this");
  const deleted = await automation.deleteScheduledTask(result.task.id, root);
  assert.equal(deleted.deletedId, result.task.id);
  assert.equal((await automation.scheduleSnapshot(root)).total, 0);
});

test("plan mode rejects Web schedule mutations and corrupt storage is never overwritten", async (t) => {
  const root = await fixture(t);
  const offline = await automation.scheduleSnapshot(root);
  assert.equal(offline.runtime.status, "offline");
  await assert.rejects(access(path.join(root, ".workagent", "workspace")), { code: "ENOENT" }, "GET must not create workspace directories");
  const agentDir = path.join(root, ".workagent", "agent");
  policy.writePolicyMode("plan", agentDir);
  await assert.rejects(automation.createScheduledTask({ name: "blocked", schedule: "* * * * *", prompt: "do it" }, root), (error) => error.code === "PLAN_MODE_BLOCKED");
  const taskPath = path.join(root, ".workagent", "workspace", ".workagent", "scheduled_tasks.json");
  await mkdir(path.dirname(taskPath), { recursive: true });
  const corrupt = "{broken";
  await writeFile(taskPath, corrupt);
  await assert.rejects(automation.scheduleSnapshot(root), (error) => error.code === "SCHEDULE_STORE_CORRUPT");
  assert.equal(await readFile(taskPath, "utf8"), corrupt);
});

test("native scheduler fires to the active session, stops in plan, and hands ownership to a surviving session", async (t) => {
  const root = await fixture(t);
  const agentDir = path.join(root, ".workagent", "agent");
  const { cwd } = await workspaceModule.ensureWorkspace(root);
  policy.writePolicyMode("review", agentDir);
  const created = await automation.createScheduledTask({ name: "timer test", schedule: "*/1 * * * * *", prompt: "deliver timer test" }, root);
  const taskPath = path.join(cwd, ".workagent", "scheduled_tasks.json");
  const lockPath = path.join(cwd, ".workagent", "scheduled_tasks.lock");
  const sessions = [];
  t.after(async () => { await Promise.all(sessions.map((session) => session.shutdown())); });

  function makeSession(sessionId) {
    const handlers = new Map();
    const deliveries = [];
    const pi = {
      registerTool() {},
      on(name, handler) { handlers.set(name, handler); },
      sendUserMessage(...args) { deliveries.push(args); },
    };
    const session = {
      deliveries,
      start: async () => {
        const extension = await automation.createWorkAgentRoutinesExtension(agentDir, root);
        extension.factory(pi);
        await handlers.get("session_start")({}, { cwd, sessionManager: { getSessionId: () => sessionId } });
      },
      shutdown: () => handlers.get("session_shutdown")(),
    };
    sessions.push(session);
    return session;
  }
  async function waitFor(predicate, timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (await predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return await predicate();
  }

  const first = makeSession("routine-owner-a");
  await first.start();
  assert.equal(hasActiveSessionLivenessProvider({ sessionId: "routine-owner-a" }), true);
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).sessionId, "routine-owner-a");
  assert.equal(await waitFor(() => first.deliveries.length > 0, 3500), true, "native timer should deliver a due task");
  assert.equal(first.deliveries[0][0], "deliver timer test");
  assert.equal(first.deliveries[0][1].deliverAs, "followUp");
  const beforePlan = await readFile(taskPath, "utf8");
  policy.writePolicyMode("plan", agentDir);
  assert.equal(hasActiveSessionLivenessProvider({ sessionId: "routine-owner-a" }), false);
  await assert.rejects(access(lockPath), { code: "ENOENT" });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(await readFile(taskPath, "utf8"), beforePlan, "plan must stop before scheduler state changes");

  policy.writePolicyMode("review", agentDir);
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).sessionId, "routine-owner-a");
  const second = makeSession("routine-owner-b");
  await second.start();
  await first.shutdown();
  assert.equal(hasActiveSessionLivenessProvider({ sessionId: "routine-owner-a" }), false);
  assert.equal(await waitFor(async () => {
    try { return JSON.parse(await readFile(lockPath, "utf8")).sessionId === "routine-owner-b"; } catch { return false; }
  }, 6500), true, "surviving native scheduler should acquire the lock after the owner exits");
  assert.equal((await automation.scheduleSnapshot(root)).runtime.ownerSessionId, "routine-owner-b");
  await second.shutdown();
  await automation.deleteScheduledTask(created.task.id, root);
});
