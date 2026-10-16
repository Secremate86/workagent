import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const baseUrl = (process.env.WORKAGENT_URL ?? "http://127.0.0.1:30141").replace(/\/$/, "");
const qaDir = join(process.cwd(), ".workagent", "qa");
const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const pageErrors = [];
const consoleErrors = [];
const failedRequests = [];

mkdirSync(qaDir, { recursive: true });

async function checkReady() {
  const response = await fetch(`${baseUrl}/api/workagent/bootstrap`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200, `bootstrap returned HTTP ${response.status}`);
  const bootstrap = await response.json();
  assert.equal(bootstrap.officeReady, true, `office worker is not ready: ${bootstrap.officeError ?? "unknown error"}`);
  assert.ok(Array.isArray(bootstrap.exampleInputs) && bootstrap.exampleInputs.length >= 2, "two example CSV inputs should be installed");
  console.log(`Ready: ${baseUrl}; examples: ${bootstrap.exampleInputs.slice(0, 2).join(", ")}`);
}

async function main() {
  await checkReady();
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.WORKAGENT_BROWSER_PATH
      ? { executablePath: process.env.WORKAGENT_BROWSER_PATH }
      : existsSync(edgePath) ? { executablePath: edgePath } : {}),
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", error => pageErrors.push(error.stack ?? error.message));
    page.on("console", message => {
      if (message.type() !== "error") return;
      const text = message.text();
      consoleErrors.push(text);
      if (/hydration failed|hydration error|too many re-renders|maximum update depth|cannot update a component/i.test(text)) {
        pageErrors.push(`runtime console error: ${text}`);
      }
    });
    page.on("requestfailed", request => failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "failed"}`));

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "今天，有什么想一起完成？" }).waitFor();
    await page.screenshot({ path: join(qaDir, "workagent-desktop.png"), fullPage: true });
    console.log("PASS: desktop home and welcome state");

    await page.getByRole("button", { name: "模型与账号设置", exact: true }).click();
    const quickModel = page.getByRole("dialog", { name: "连接你的 AI 模型" });
    await quickModel.waitFor();
    assert.equal(await quickModel.getByLabel("API 地址", { exact: true }).inputValue(), "https://api.openai.com/v1");
    assert.equal(await quickModel.getByLabel("API Key", { exact: true }).getAttribute("type"), "password");
    await quickModel.getByLabel("接口协议", { exact: true }).selectOption("openai-responses");
    await quickModel.getByRole("button", { name: "关闭模型配置", exact: true }).click();
    await quickModel.waitFor({ state: "detached" });
    console.log("PASS: OpenAI-compatible model setup fields and Responses protocol, no credential saved");

    await page.getByRole("button", { name: /^全部任务/ }).click();
    await page.getByRole("heading", { name: "每一份进展，都在这里" }).waitFor();
    const emptyState = page.getByText("还没有任务", { exact: true });
    if (await emptyState.count()) {
      await emptyState.waitFor({ state: "visible" });
    } else {
      await page.getByPlaceholder("搜索任务或工作空间…", { exact: true }).fill("__workagent_smoke_no_matching_task__");
      await page.getByText("没有找到匹配的任务", { exact: true }).waitFor();
    }
    console.log("PASS: task list empty state");

    await page.getByRole("button", { name: /^能力中心/ }).click();
    await page.getByRole("heading", { name: "找到适合你的工作方式" }).waitFor();
    const manageSkills = page.getByRole("button", { name: /技能 查看、安装和管理可复用的工作方法 管理/ });
    await manageSkills.click();
    const settings = page.getByRole("dialog", { name: "设置" });
    await settings.waitFor();
    assert.equal(await settings.getByRole("button", { name: "技能", exact: true }).getAttribute("aria-current"), "page");
    await page.keyboard.press("Escape");
    await settings.waitFor({ state: "detached" });
    console.log("PASS: capabilities and skills management entry");

    // This local operation needs no model credentials and does not open or confirm project trust.
    const reconcileButton = page.getByRole("button", { name: "核对示例表格", exact: true });
    await reconcileButton.click();
    const deadline = Date.now() + 120_000;
    const successBanner = page.locator(".wa-banner.success");
    const officeError = page.locator(".wa-banner.error");
    while (Date.now() < deadline && !(await successBanner.count())) {
      if (await officeError.count()) {
        const detail = await officeError.first().innerText();
        throw new Error(`reconcile failed: ${detail || await officeError.first().evaluate(element => element.outerHTML)}`);
      }
      await page.waitForTimeout(300);
    }
    await successBanner.waitFor({ state: "visible", timeout: Math.max(1, deadline - Date.now()) });
    const expectedFiles = ["differences.csv", "differences.xlsx", "report.md"];
    for (const filename of expectedFiles) {
      const card = page.locator(".wa-artifact-list .wa-artifact-card").filter({ hasText: filename });
      while (Date.now() < deadline && !(await card.count())) {
        await page.waitForTimeout(500);
      }
      await card.first().waitFor({ state: "visible", timeout: Math.max(1, deadline - Date.now()) });
    }

    const table = page.getByRole("table");
    await table.waitFor({ state: "visible", timeout: Math.max(1, deadline - Date.now()) });
    await table.getByRole("columnheader", { name: "type", exact: true }).waitFor();
    await table.getByRole("cell", { name: "modified", exact: true }).waitFor();
    await table.getByRole("cell", { name: "missing", exact: true }).waitFor();
    await table.getByRole("cell", { name: "added", exact: true }).waitFor();
    const downloadLink = page.locator(".wa-preview-title").getByRole("link", { name: "下载文件", exact: true });
    const downloadHref = await downloadLink.getAttribute("href");
    assert.ok(downloadHref, "CSV preview should expose a download URL");
    const downloadResponse = await page.request.get(new URL(downloadHref, baseUrl).toString());
    assert.equal(downloadResponse.status(), 200, "CSV download URL should return HTTP 200");
    assert.match(downloadResponse.headers()["content-type"] ?? "", /^(text\/csv|application\/octet-stream)/i);
    assert.match(downloadResponse.headers()["content-disposition"] ?? "", /attachment/i);
    const downloadedCsv = (await downloadResponse.body()).toString("utf8");
    assert.match(downloadedCsv, /type,编号,baseline,comparison/);
    assert.match(downloadedCsv, /modified/);
    assert.match(downloadedCsv, /A004/);
    await page.screenshot({ path: join(qaDir, "workagent-results.png"), fullPage: true });
    console.log("PASS: reconcile produced CSV/XLSX/Markdown, CSV preview and valid download");

    await page.locator(".wa-artifact-list .wa-artifact-card").filter({ hasText: "report.md" }).first().getByRole("button").click();
    const fileTabs = page.getByRole("tablist", { name: "已打开的文件" });
    await fileTabs.getByRole("tab", { name: "report.md", exact: true }).waitFor();
    await fileTabs.getByRole("tab", { name: "differences.csv", exact: true }).click();
    await fileTabs.getByRole("button", { name: "关闭 report.md", exact: true }).click();
    await fileTabs.getByRole("tab", { name: "report.md", exact: true }).waitFor({ state: "detached" });
    await fileTabs.getByRole("tab", { name: "differences.csv", exact: true }).waitFor();
    await page.getByRole("button", { name: "全屏预览", exact: true }).click();
    await page.locator(".wa-output-panel.fullscreen").waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".wa-output-panel.fullscreen").waitFor({ state: "detached" });
    console.log("PASS: multiple file tabs, switching, close tab, fullscreen and Escape");

    const panel = page.locator(".wa-output-panel");
    const separator = page.getByRole("separator", { name: "调整成果面板宽度", exact: true });
    const content = page.locator(".wa-content");
    const widths = async () => ({
      panel: await panel.evaluate(element => element.getBoundingClientRect().width),
      content: await content.evaluate(element => element.getBoundingClientRect().width),
    });
    const initialWidths = await widths();
    await separator.focus();
    for (let index = 0; index < 32; index += 1) await separator.press("ArrowLeft");
    await page.evaluate(() => new Promise(requestAnimationFrame));
    let resizedWidths = await widths();
    assert.ok(resizedWidths.panel > initialWidths.panel + 100, `ArrowLeft should widen the result panel: ${JSON.stringify({ initialWidths, resizedWidths })}`);
    assert.ok(resizedWidths.content >= 480, `desktop chat area narrowed below 480px: ${JSON.stringify(resizedWidths)}`);

    await page.setViewportSize({ width: 1100, height: 900 });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    resizedWidths = await widths();
    assert.ok(resizedWidths.content >= 480, `chat area narrowed below 480px at 1100px viewport: ${JSON.stringify(resizedWidths)}`);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    resizedWidths = await widths();
    assert.ok(resizedWidths.content >= 480, `chat area should remain usable after restoring desktop viewport: ${JSON.stringify(resizedWidths)}`);
    console.log(`PASS: result panel keyboard resize preserves >=480px chat area at 1440px and 1100px (${JSON.stringify(resizedWidths)})`);

    await page.getByRole("button", { name: "生成示例文档", exact: true }).click();
    const reportDeadline = Date.now() + 120_000;
    for (const filename of ["report.md", "report.docx"]) {
      const card = page.locator(".wa-artifact-list .wa-artifact-card").filter({ hasText: filename });
      while (Date.now() < reportDeadline && !(await card.count())) await page.waitForTimeout(500);
      await card.first().waitFor({ state: "visible", timeout: Math.max(1, reportDeadline - Date.now()) });
    }
    await page.locator(".wa-banner.success").filter({ hasText: "报告已生成" }).waitFor({ state: "visible", timeout: Math.max(1, reportDeadline - Date.now()) });
    await page.locator(".wa-preview").getByText("WorkAgent 本地办公验证", { exact: true }).waitFor({ timeout: Math.max(1, reportDeadline - Date.now()) });
    console.log("PASS: example Markdown and DOCX report generated");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "今天，有什么想一起完成？" }).waitFor();
    const measureWidth = () => page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    let dimensions = await measureWidth();
    assert.ok(Math.max(dimensions.document, dimensions.body) <= dimensions.viewport, `mobile home overflows horizontally: ${JSON.stringify(dimensions)}`);
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await page.locator(".wa-sidebar.open").waitFor();
    dimensions = await measureWidth();
    assert.ok(Math.max(dimensions.document, dimensions.body) <= dimensions.viewport, `mobile navigation overflows horizontally: ${JSON.stringify(dimensions)}`);
    await page.screenshot({ path: join(qaDir, "workagent-mobile.png"), fullPage: true });
    await page.getByRole("button", { name: "关闭导航", exact: true }).click();
    await page.locator(".wa-sidebar.open").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await page.locator(".wa-sidebar.open").waitFor();
    await page.getByRole("button", { name: /^能力中心/ }).click();
    await page.getByRole("heading", { name: "找到适合你的工作方式" }).waitFor();
    await page.locator(".wa-sidebar.open").waitFor({ state: "detached" });
    dimensions = await measureWidth();
    assert.ok(Math.max(dimensions.document, dimensions.body) <= dimensions.viewport, `mobile capability page overflows horizontally: ${JSON.stringify(dimensions)}`);
    console.log("PASS: 390x844 mobile viewport, no horizontal overflow, navigation opens and closes");

    assert.deepEqual(pageErrors, [], `browser runtime errors:\n${pageErrors.join("\n")}`);
    console.log("PASS: no pageerror, hydration, or render-loop errors");
    if (consoleErrors.length) console.log(`Non-fatal browser console errors (${consoleErrors.length}):\n- ${consoleErrors.join("\n- ")}`);
    if (failedRequests.length) console.log(`Non-fatal failed resource requests (${failedRequests.length}):\n- ${failedRequests.join("\n- ")}`);
    console.log(`Screenshots: ${join(qaDir, "workagent-desktop.png")}, ${join(qaDir, "workagent-results.png")}, ${join(qaDir, "workagent-mobile.png")}`);
    await context.close();
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
