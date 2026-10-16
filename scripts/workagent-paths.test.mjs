import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { prepareWorkAgentPaths } from "./workagent-paths.mjs";

function fixture(t) {
  const parent = path.resolve(".workagent/test-fixtures");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, "namespace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("migration retains credentials, session ancestry and tasks without recreating removed data", t => {
  const root = fixture(t);
  const old = path.join(root, ".workagent/pi-agent");
  mkdirSync(path.join(old, "sessions/project"), { recursive: true });
  writeFileSync(path.join(old, "auth.json"), '{"test":"opaque"}');
  const header = { type: "session", parentSession: path.join(old, "sessions/project/parent.jsonl") };
  writeFileSync(path.join(old, "sessions/project/child.jsonl"), JSON.stringify(header) + '\n{"content":".pi stays in user text"}\n');
  const legacyConfig = path.join(root, ".workagent/workspace/.pi");
  mkdirSync(legacyConfig, { recursive: true });
  writeFileSync(path.join(legacyConfig, "scheduled_tasks.json"), '{"version":1,"tasks":[]}');
  const { agentDir } = prepareWorkAgentPaths(root);
  assert.equal(agentDir, path.join(root, ".workagent/agent"));
  assert.equal(readFileSync(path.join(agentDir, "auth.json"), "utf8"), '{"test":"opaque"}');
  const session = readFileSync(path.join(agentDir, "sessions/project/child.jsonl"), "utf8");
  assert.equal(JSON.parse(session.split("\n")[0]).parentSession, path.join(agentDir, "sessions/project/parent.jsonl"));
  assert.ok(session.includes(".pi stays in user text"));
  assert.equal(existsSync(legacyConfig), false);
  assert.equal(existsSync(path.join(root, ".workagent/migration-backups/workspace-config/scheduled_tasks.json")), true);
  const tasks = path.join(root, ".workagent/workspace/.workagent/scheduled_tasks.json");
  rmSync(tasks);
  prepareWorkAgentPaths(root);
  assert.equal(existsSync(tasks), false, "completed migration must never restore deleted tasks");
});

test("migration refuses conflicting files and preserves both originals", t => {
  const root = fixture(t);
  for (const name of ["pi-agent", "agent"]) mkdirSync(path.join(root, ".workagent", name), { recursive: true });
  writeFileSync(path.join(root, ".workagent/pi-agent/settings.json"), '{"value":"old"}');
  writeFileSync(path.join(root, ".workagent/agent/settings.json"), '{"value":"new"}');
  assert.throws(() => prepareWorkAgentPaths(root), /冲突/);
  assert.equal(readFileSync(path.join(root, ".workagent/agent/settings.json"), "utf8"), '{"value":"new"}');
  assert.equal(existsSync(path.join(root, ".workagent/pi-agent/settings.json")), true);
});
