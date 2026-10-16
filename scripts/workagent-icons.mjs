import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const svg = await readFile(path.resolve("public/workagent.svg"), "utf8");
const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const browser = await chromium.launch({ headless: true, ...(existsSync(edge) ? { executablePath: edge } : {}) });
try {
  for (const [name, size] of [["workagent-192", 192], ["workagent-512", 512], ["workagent-apple-touch-icon", 180]]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:#e8f2ee}svg{display:block;width:100%;height:100%}</style>${svg}`);
    await page.screenshot({ path: path.resolve(`public/icons/${name}.png`) });
    await page.close();
  }
} finally { await browser.close(); }
