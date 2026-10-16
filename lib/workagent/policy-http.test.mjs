import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, tsconfigPaths: true });
const { POST: officePost } = await jiti.import("../../app/api/workagent/office/route.ts");
const { GET: policyGet, PUT: policyPut } = await jiti.import("../../app/api/workagent/policy/route.ts");
const { writePolicyMode } = await jiti.import("./policy.ts");
const base = "http://127.0.0.1:30141";

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "workagent-policy-http-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function put(body, extraHeaders = {}) {
  return policyPut(new Request(`${base}/api/workagent/policy`, {
    method: "PUT", headers: { host: "127.0.0.1:30141", "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  }));
}

test("direct office HTTP refuses plan mode before creating any artifact", async t => {
  const dir = await fixture(t);
  writePolicyMode("plan", dir);
  const outputs = path.resolve(".workagent/workspace/outputs");
  const before = await readdir(outputs).catch(() => []);
  const response = await officePost(new Request(`${base}/api/workagent/office`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "report", options: { title: "must not exist", content: "blocked" } }),
  }));
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /计划模式/);
  assert.deepEqual(await readdir(outputs).catch(() => []), before);
});

test("policy HTTP rejects cross-origin, invalid modes and non-JSON without changing mode", async t => {
  await fixture(t);
  assert.equal((await put({ mode: "auto" }, { origin: "https://untrusted.example" })).status, 403);
  assert.equal((await put({ mode: "bogus" })).status, 400);
  assert.equal((await put({ mode: "auto" }, { "content-type": "text/plain" })).status, 415);
  assert.equal((await policyGet().json()).mode, "review");
  assert.equal((await put({ mode: "plan" })).status, 200);
  assert.equal((await policyGet().json()).mode, "plan");
});

test("an unreadable policy fails closed on the direct office HTTP route", async t => {
  const dir = await fixture(t);
  await writeFile(path.join(dir, "workagent-policy.json"), "{broken");
  const response = await officePost(new Request(`${base}/api/workagent/office`, {
    method: "POST", body: JSON.stringify({ operation: "inventory" }),
  }));
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /执行策略文件无法读取/);
});
