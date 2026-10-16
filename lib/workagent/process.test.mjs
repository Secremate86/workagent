import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { runBoundedProcess } = await jiti.import("./process.ts");

test("worker runner passes stdin without a shell and strips model secrets", async () => {
  const before = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "must-not-reach-worker";
  try {
    const result = await runBoundedProcess(process.execPath, ["-e", "let data='';process.stdin.on('data',x=>data+=x);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({data,secret:process.env.OPENAI_API_KEY??null})))"], { cwd: process.cwd(), input: "literal $(not-a-command)" });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), { data: "literal $(not-a-command)", secret: null });
  } finally {
    if (before === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = before;
  }
});

test("worker runner reports process failures", async () => {
  const result = await runBoundedProcess(process.execPath, ["-e", "process.stderr.write('invalid input');process.exit(7)"], { cwd: process.cwd() });
  assert.equal(result.exitCode, 7);
  assert.equal(result.stderr, "invalid input");
  await assert.rejects(runBoundedProcess("workagent-command-that-does-not-exist", [], { cwd: process.cwd() }), { code: "WORKER_UNAVAILABLE" });
});

test("worker runner terminates excessive output, timeout and cancelled work", async () => {
  await assert.rejects(runBoundedProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], { cwd: process.cwd(), maxOutputBytes: 100 }), { code: "OUTPUT_LIMIT" });
  await assert.rejects(runBoundedProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: process.cwd(), timeoutMs: 100 }), { code: "TIMEOUT" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runBoundedProcess(process.execPath, [], { cwd: process.cwd(), signal: controller.signal }), { code: "CANCELLED" });
});
