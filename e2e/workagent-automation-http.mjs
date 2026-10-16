import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const base = (process.env.WORKAGENT_URL ?? "http://127.0.0.1:30141").replace(/\/$/, "");
async function api(route, body, method = "POST", headers = {}) {
  const response = await fetch(`${base}${route}`, {
    method: body === undefined ? "GET" : method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, body: await response.json() };
}
async function setMode(mode) {
  const response = await api("/api/workagent/policy", { mode }, "PUT");
  assert.equal(response.status, 200);
}
const policy = await api("/api/workagent/policy");
assert.equal(policy.status, 200);
const name = `HTTP验收-${randomUUID()}`;
const content = `显式记忆接口验收 ${randomUUID()}，此条目将在验收后删除。`;
let taskId;
let memoryId;
try {
  await setMode("review");
  const schedules = await api("/api/workagent/schedules");
  assert.equal(schedules.status, 200, schedules.body.error);
  const beforeMemory = await api("/api/workagent/memory");
  assert.equal(beforeMemory.status, 200, beforeMemory.body.error);
  assert.equal(beforeMemory.body.status.search, "disabled");
  const task = await api("/api/workagent/schedules", {
    name, schedule: "0 0 1 1 *", prompt: "本条仅验证任务持久化，验收后立即删除。", recurring: false,
  });
  assert.equal(task.status, 201, task.body.error);
  taskId = task.body.task.id;
  assert.ok(task.body.runtime);
  assert.equal((await api("/api/workagent/schedules")).body.tasks.some(item => item.id === taskId), true);
  const memory = await api("/api/workagent/memory", { content });
  assert.equal(memory.status, 200, memory.body.error);
  memoryId = memory.body.id;
  let snapshot = (await api("/api/workagent/memory")).body;
  assert.ok(snapshot.entries.some(item => item.id === memoryId && item.content.includes(content)));
  console.log("PASS: real HTTP creates and reads persistent schedule and explicit memory");

  await setMode("plan");
  const plannedSnapshot = await api("/api/workagent/schedules");
  assert.equal(plannedSnapshot.body.runtime.status, "plan");
  for (const [route, body, method] of [
    ["/api/workagent/schedules", { name, schedule: "* * * * *", prompt: "blocked" }, "POST"],
    ["/api/workagent/schedules", { id: taskId }, "DELETE"],
    ["/api/workagent/memory", { content: "blocked-memory" }, "POST"],
    ["/api/workagent/memory", { id: memoryId }, "DELETE"],
  ]) {
    const response = await api(route, body, method);
    assert.equal(response.status, 403, `${method} ${route}: ${response.body.error}`);
    assert.equal(response.body.code, "PLAN_MODE_BLOCKED");
  }
  assert.ok((await api("/api/workagent/schedules")).body.tasks.some(item => item.id === taskId));
  snapshot = (await api("/api/workagent/memory")).body;
  assert.ok(snapshot.entries.some(item => item.id === memoryId));
  console.log("PASS: plan rejects schedule and memory create/delete on the server, preserving saved records");

  await setMode("review");
  for (const route of ["/api/workagent/memory", "/api/workagent/schedules"]) {
    const response = await api(route, {}, "POST", { origin: "https://untrusted.example" });
    assert.equal(response.status, 403);
  }
  const invalid = await api("/api/workagent/schedules", { name, schedule: "invalid", prompt: "invalid" });
  assert.equal(invalid.status, 400);
  assert.equal((await api("/api/workagent/memory", { content: " " })).status, 400);
  assert.equal((await api("/api/workagent/schedules", { id: taskId }, "DELETE")).status, 200);
  taskId = undefined;
  assert.equal((await api("/api/workagent/memory", { id: memoryId }, "DELETE")).status, 200);
  const after = (await api("/api/workagent/memory")).body;
  assert.equal(after.entries.some(item => item.id === memoryId), false);
  assert.equal(after.files.longTerm.includes(content), false);
  memoryId = undefined;
  console.log("PASS: invalid/origin requests are refused; exact saved records can be deleted without fake success");
} finally {
  await setMode("review");
  // Recover identifiers if a mutation succeeded but its HTTP response failed.
  if (!taskId) {
    const saved = await api("/api/workagent/schedules").catch(() => null);
    taskId = saved?.body.tasks?.find(item => item.name === name)?.id;
  }
  if (!memoryId) {
    const saved = await api("/api/workagent/memory").catch(() => null);
    memoryId = saved?.body.entries?.find(item => item.content.includes(content))?.id;
  }
  if (taskId) await api("/api/workagent/schedules", { id: taskId }, "DELETE");
  if (memoryId) await api("/api/workagent/memory", { id: memoryId }, "DELETE");
  await setMode(policy.body.mode);
}
