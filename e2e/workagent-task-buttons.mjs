import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { chromium } from "playwright";

const base = (process.env.WORKAGENT_URL || "http://127.0.0.1:30141").replace(/\/$/, "");
const password = process.env.PI_WEB_PASSWORD || (process.env.WORKAGENT_AUTH_FILE
  ? readFileSync(process.env.WORKAGENT_AUTH_FILE, "utf8").match(/^PI_WEB_PASSWORD=(.+)$/m)?.[1].trim()
  : undefined);
const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const browser = await chromium.launch({ headless: true, ...(existsSync(edge) ? { executablePath: edge } : {}) });
try {
  const context = await browser.newContext();
  // Exercise the public HTTP case even when run against localhost or HTTPS.
  await context.addInitScript(() => Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true }));
  if (password) {
    const response = await context.request.post(`${base}/api/web-auth`, { data: { password }, headers: { Origin: base } });
    assert.ok(response.ok(), `Login HTTP ${response.status()}`);
  }
  const page = await context.newPage();
  const errors = [];
  let prompts = 0;
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/agent/")) {
      try { if (request.postDataJSON()?.type === "prompt") prompts++; } catch { /* not a command */ }
    }
  });
  await page.goto(base, { waitUntil: "networkidle" });
  const input = page.locator("textarea").first();
  await input.waitFor();
  await input.fill("temporary draft");
  await page.locator(".wa-new-task").click();
  await page.waitForTimeout(250);
  assert.deepEqual(errors, [], "New task must work without crypto.randomUUID");
  assert.equal(await input.inputValue(), "", "New task must open a fresh draft");
  console.log("PASS: new task opens a fresh draft without randomUUID");

  const cards = [
    ["让表格自己对上账", "office_reconcile"],
    ["给文件做一次整理", "office_inventory"],
    ["把想法变成文档", "office_report"],
    ["研究一个新课题", "研究一个新课题"],
  ];
  const recent = page.locator(".wa-recent-tasks .wa-task-select").first();
  for (const fromExisting of [false, true]) {
    if (fromExisting && await recent.count() === 0) throw Error("An existing session is required to test task switching");
    for (const [title, expected] of cards) {
      if (fromExisting) {
        await recent.click();
        await page.waitForFunction(() => new URL(location.href).searchParams.has("session"));
      } else {
        await page.locator(".wa-new-task").click();
      }
      await page.getByRole("button", { name: "能力中心", exact: true }).click();
      await page.locator(".wa-capability-card").filter({ hasText: title }).click();
      await page.waitForFunction(expected => document.querySelector("textarea")?.value.includes(expected), expected);
      assert.equal(new URL(page.url()).searchParams.has("session"), false, "Card must use a new draft");
      assert.deepEqual(errors, []);
      console.log(`PASS: ${fromExisting ? "existing task" : "empty draft"} -> ${title}`);
    }
  }
  assert.equal(prompts, 0, "Buttons must not send prompts automatically");
} finally {
  await browser.close();
}
