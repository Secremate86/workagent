import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

// Uses explicit shell commands and native extension UI; no model request or test provider.
const base = (process.env.WORKAGENT_URL ?? "http://127.0.0.1:30141").replace(/\/$/, "");
async function api(url, body, method = "POST") {
  const response = await fetch(`${base}${url}`, {
    method: body === undefined ? "GET" : method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(150_000),
  });
  const data = await response.json();
  return { status: response.status, data };
}
async function mode(value) {
  const result = await api("/api/workagent/policy", { mode: value }, "PUT");
  assert.equal(result.status, 200);
}
const initial = await api("/api/workagent/policy");
assert.equal(initial.status, 200);
const bootstrap = await api("/api/workagent/bootstrap");
assert.equal(bootstrap.status, 200);
const qa = path.resolve(".workagent/qa");
await mkdir(qa, { recursive: true });
const markerRoot = path.join(bootstrap.data.cwd, `policy-ui-${randomUUID()}`);
await mkdir(markerRoot);
if (process.platform === "win32") {
  const bash = process.env.WORKAGENT_TEST_BASH_PATH ?? path.join(homedir(), "scoop/apps/git/current/bin/bash.exe");
  if (existsSync(bash)) {
    await mkdir(path.join(markerRoot, ".workagent"));
    await writeFile(path.join(markerRoot, ".workagent/settings.json"), JSON.stringify({ shellPath: bash }));
  }
}
const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
let browser;
let sessionId;
let pending;
try {
  // Persist a shell-only test session so a page reload can find its history.
  await mode("auto");
  const created = await api("/api/agent/new", { cwd: markerRoot, type: "bash", command: "echo workagent-policy-ui-fixture" });
  assert.equal(created.status, 200, created.data.error ?? "fixture session creation failed");
  assert.equal(created.data.success, true);
  sessionId = created.data.sessionId;
  await mode("review");
  browser = await chromium.launch({ headless: true, ...(existsSync(edge) ? { executablePath: edge } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && /Failed to load tools|hydration|render-loop|maximum update depth/i.test(message.text())) errors.push(message.text());
  });
  page.setDefaultTimeout(20_000);
  await page.goto(`${base}/?session=${encodeURIComponent(sessionId)}`);
  const title = page.getByText("高风险操作审批", { exact: true });
  const execute = name => {
    const file = path.join(markerRoot, `${name}.txt`).replace(/\\/g, "/");
    assert.ok(!/["'\r\n]/.test(file), "fixture path must be safe in the literal command");
    pending = api(`/api/agent/${sessionId}`, { type: "bash", command: `node -e "require('node:fs').writeFileSync('${file}','policy-ui-marker')"` });
    return file;
  };
  const approved = execute("approved");
  await title.waitFor();
  assert.equal(existsSync(approved), false);
  await page.reload();
  await title.waitFor();
  assert.equal(existsSync(approved), false);
  await page.screenshot({ path: path.join(qa, "workagent-policy-pending.png"), fullPage: true });
  await page.getByRole("button", { name: "确认", exact: true }).click();
  assert.equal((await pending).status, 200);
  assert.equal(await readFile(approved, "utf8"), "policy-ui-marker");
  console.log("PASS: browser refresh restores pending approval; marker appears only after Confirm");

  const rejected = execute("rejected");
  await title.waitFor();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await pending;
  assert.equal(existsSync(rejected), false);
  console.log("PASS: Cancel leaves the marker absent");

  const stopped = execute("stopped");
  await title.waitFor();
  await api(`/api/agent/${sessionId}`, { type: "abort" });
  await pending;
  await title.waitFor({ state: "hidden" });
  assert.equal(existsSync(stopped), false);
  console.log("PASS: Stop closes the approval and prevents execution");

  await mode("plan");
  const planned = execute("planned");
  assert.notEqual((await pending).status, 200);
  assert.equal(existsSync(planned), false);
  assert.equal(await title.count(), 0);
  await mode("auto");
  const automatic = execute("automatic");
  assert.equal((await pending).status, 200);
  assert.equal(await readFile(automatic, "utf8"), "policy-ui-marker");
  assert.equal(await title.count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS: plan prevents shell execution; auto executes without an approval dialog; no pageerror");
} finally {
  if (sessionId) await api(`/api/agent/${sessionId}`, { type: "abort" }).catch(() => {});
  if (pending) await pending.catch(() => {});
  await browser?.close();
  await mode(initial.data.mode);
  if (sessionId) {
    const deleted = await api(`/api/sessions/${sessionId}`, {}, "DELETE");
    assert.equal(deleted.status, 200, "the isolated shell fixture session should be removed");
  }
  assert.equal(path.dirname(markerRoot), bootstrap.data.cwd);
  await rm(markerRoot, { recursive: true, force: true });
}
