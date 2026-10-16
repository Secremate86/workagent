import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

const base = process.env.WORKAGENT_URL ?? "http://127.0.0.1:30141";
const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const browser = await chromium.launch({ headless: true, ...(existsSync(edge) ? { executablePath: edge } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base);
  await page.locator(".wa-welcome").waitFor();
  assert.equal(await page.locator('a[href^="/advanced"]').count(), 0);
  assert.equal(await page.getByRole("link", { name: /开发工作台/ }).count(), 0);
  await page.locator(".wa-settings-link").click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await dialog.waitFor();
  for (const name of ["常规", "模型", "技能", "子代理", "插件", "MCP"]) {
    const button = dialog.locator(".settings-section-tabs").getByRole("button", { name, exact: true });
    await button.click();
    const text = await dialog.innerText();
    assert.doesNotMatch(text, /\.pi(?:[\\/]|\b)|Pi Web|\bpi v\d/i, `${name} must show actual WorkAgent paths`);
  }
  await page.screenshot({ path: ".workagent/qa/workagent-namespace-settings.png", fullPage: true });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(new URL(page.url()).pathname, "/");
  console.log("PASS: main UI and settings have WorkAgent paths and no advanced navigation entry");
  const manifest = await (await page.request.get(`${base}/manifest.webmanifest`)).json();
  assert.equal(manifest.name, "WorkAgent");
  assert.ok(manifest.icons.every(icon => icon.src.includes("workagent")));
  for (const icon of manifest.icons) assert.equal((await page.request.get(`${base}${icon.src}`)).status(), 200);
  const offline = await (await page.request.get(`${base}/offline.html`)).text();
  assert.ok(offline.includes("WorkAgent is offline"));
  assert.ok(!offline.includes("Pi Web"));
  await page.goto(`${base}/advanced`);
  await page.locator(".new-session-hero").waitFor();
  assert.equal(new URL(page.url()).pathname, "/advanced");
  assert.doesNotMatch(await page.locator("body").innerText(), /Pi Web|\bpi v\d/i);
  assert.deepEqual(errors, []);
  console.log("PASS: advanced route remains directly accessible; install icons and offline page use WorkAgent");
} finally { await browser.close(); }
