import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

const base = (process.env.WORKAGENT_URL ?? "http://127.0.0.1:30141").replace(/\/$/, "");
async function api(route, body, method = "POST") {
  const response = await fetch(`${base}${route}`, {
    method: body === undefined ? "GET" : method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, body: await response.json() };
}
const initial = await api("/api/workagent/policy");
assert.equal(initial.status, 200);
const taskName = `界面验收-${randomUUID()}`;
const content = `明确保存的界面验收事实 ${randomUUID()}（测试后删除）`;
const qa = path.resolve(".workagent/qa");
await mkdir(qa, { recursive: true });
const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const browser = await chromium.launch({ headless: true, ...(existsSync(edge) ? { executablePath: edge } : {}) });
try {
  await api("/api/workagent/policy", { mode: "review" }, "PUT");
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && /hydration|maximum update depth|Failed to load tools/i.test(message.text())) errors.push(message.text());
  });
  page.on("dialog", dialog => dialog.accept());
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "执行与自动化", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "执行与自动化", exact: true });
  await panel.getByRole("button", { name: "定时任务", exact: true }).click();
  await panel.getByLabel("任务名称", { exact: true }).fill(taskName);
  await panel.getByLabel("执行时间（cron）", { exact: true }).fill("invalid");
  await panel.getByLabel("任务内容", { exact: true }).fill("只验证任务保存与管理，测试后立即删除。");
  await panel.getByRole("button", { name: "创建任务", exact: true }).click();
  await panel.getByRole("alert").filter({ hasText: /cron/i }).waitFor();
  // A healthy polling GET must not erase an unresolved mutation error.
  await page.waitForTimeout(5500);
  await panel.getByRole("alert").filter({ hasText: /cron/i }).waitFor();
  await panel.getByLabel("执行时间（cron）", { exact: true }).fill("0 0 1 1 *");
  await panel.getByLabel("重复执行", { exact: true }).uncheck();
  await panel.getByRole("button", { name: "创建任务", exact: true }).click();
  const taskRow = panel.locator(".wa-automation-list > li").filter({ hasText: taskName });
  await taskRow.waitFor();
  assert.ok((await api("/api/workagent/schedules")).body.tasks.some(task => task.name === taskName));
  await page.screenshot({ path: path.join(qa, "workagent-schedules.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "hidden" });
  await page.reload();
  await page.getByRole("button", { name: "执行与自动化", exact: true }).click();
  await panel.getByRole("button", { name: "定时任务", exact: true }).click();
  await taskRow.waitFor();
  console.log("PASS: real cron errors survive polling; scheduled task persists across page reload");

  await panel.getByRole("button", { name: "长期记忆", exact: true }).click();
  await panel.getByLabel("明确保存一条记忆", { exact: true }).fill(content);
  await panel.getByRole("button", { name: "保存到长期记忆", exact: true }).click();
  const memoryRow = panel.locator(".wa-automation-list > li").filter({ hasText: content });
  await memoryRow.waitFor();
  assert.ok((await api("/api/workagent/memory")).body.entries.some(entry => entry.content.includes(content)));
  await page.screenshot({ path: path.join(qa, "workagent-memory.png"), fullPage: true });
  console.log("PASS: explicit memory is saved through the UI and returned by the real backend");

  await panel.getByRole("button", { name: "权限审批", exact: true }).click();
  await panel.locator("#wa-execution-mode").selectOption("plan");
  await page.waitForFunction(() => document.querySelector("#wa-execution-mode")?.value === "plan");
  await panel.getByRole("button", { name: "定时任务", exact: true }).click();
  await taskRow.waitFor();
  assert.equal(await panel.getByRole("button", { name: "创建任务", exact: true }).isDisabled(), true);
  assert.equal(await taskRow.getByRole("button", { name: "删除", exact: true }).isDisabled(), true);
  await panel.getByText("计划模式下不能新建或删除任务。", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "长期记忆", exact: true }).click();
  await memoryRow.waitFor();
  assert.equal(await panel.getByRole("button", { name: "保存到长期记忆", exact: true }).isDisabled(), true);
  assert.equal(await memoryRow.getByRole("button", { name: "删除", exact: true }).isDisabled(), true);
  console.log("PASS: plan mode explains and disables schedule/memory writes, preserving read access");

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const bounds = await panel.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391);
  await page.screenshot({ path: path.join(qa, "workagent-automation-mobile.png"), fullPage: true });
  await panel.getByRole("button", { name: "权限审批", exact: true }).click();
  await panel.locator("#wa-execution-mode").selectOption("review");
  await page.waitForFunction(() => document.querySelector("#wa-execution-mode")?.value === "review");
  await panel.getByRole("button", { name: "长期记忆", exact: true }).click();
  await memoryRow.getByRole("button", { name: "删除", exact: true }).click();
  await memoryRow.waitFor({ state: "hidden" });
  await panel.getByRole("button", { name: "定时任务", exact: true }).click();
  await taskRow.getByRole("button", { name: "删除", exact: true }).click();
  await taskRow.waitFor({ state: "hidden" });
  assert.equal((await api("/api/workagent/memory")).body.files.longTerm.includes(content), false);
  assert.equal((await api("/api/workagent/schedules")).body.tasks.some(task => task.name === taskName), false);
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "hidden" });
  const readsAfterClose = [];
  const record = request => { if (/\/api\/workagent\/(memory|schedules)$/.test(request.url())) readsAfterClose.push(request.url()); };
  page.on("request", record);
  await page.waitForTimeout(5500);
  page.off("request", record);
  assert.deepEqual(readsAfterClose, [], "closed panels must stop their polling");
  assert.deepEqual(errors, []);
  console.log("PASS: mobile layout, real delete, Escape close and polling cleanup; no runtime errors");
} finally {
  await browser.close();
  await api("/api/workagent/policy", { mode: "review" }, "PUT");
  const schedules = await api("/api/workagent/schedules");
  for (const task of schedules.body.tasks ?? []) if (task.name === taskName) await api("/api/workagent/schedules", { id: task.id }, "DELETE");
  const memories = await api("/api/workagent/memory");
  for (const entry of memories.body.entries ?? []) if (entry.content.includes(content)) await api("/api/workagent/memory", { id: entry.id, target: entry.target, ...(entry.date ? { date: entry.date } : {}) }, "DELETE");
  await api("/api/workagent/policy", { mode: initial.body.mode }, "PUT");
}
