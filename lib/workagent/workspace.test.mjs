import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { ensureWorkspace, listArtifacts, resolveInputFile, validateWorkspace } = await jiti.import("./workspace.ts");
const { parseOfficeRequest } = await jiti.import("./office.ts");
const repo = fileURLToPath(new URL("../../", import.meta.url));

async function fixture(t) {
  const fixturesRoot = path.join(repo, ".workagent", "test-fixtures");
  await mkdir(fixturesRoot, { recursive: true });
  const root = await mkdtemp(path.join(fixturesRoot, "office-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "examples", "office"), { recursive: true });
  await mkdir(path.join(root, "resources", "workagent-office"), { recursive: true });
  await mkdir(path.join(root, "extensions"), { recursive: true });
  await copyFile(path.join(repo, "resources", "workagent-office", "SKILL.md"), path.join(root, "resources", "workagent-office", "SKILL.md"));
  await writeFile(path.join(root, "extensions", "workagent-office.ts"), `export {default} from ${JSON.stringify(path.join(repo, "extensions", "workagent-office.ts").replace(/\\/g, "/"))};`);
  await writeFile(path.join(root, "examples", "office", "基准.csv"), "编号,金额\n001,12\n");
  await writeFile(path.join(root, "examples", "office", "对比.csv"), "编号,金额\n001,13\n");
  return { root, ...await ensureWorkspace(root) };
}

test("bootstrap preserves existing inputs and installs discoverable Pi office resources", async (t) => {
  const workspace = await fixture(t);
  assert.deepEqual(workspace.exampleInputs, ["基准.csv", "对比.csv"]);
  await writeFile(path.join(workspace.cwd, "基准.csv"), "user modified input");
  await ensureWorkspace(workspace.root);
  assert.equal(await readFile(path.join(workspace.cwd, "基准.csv"), "utf8"), "user modified input");
  const agentDir = path.join(workspace.root, "agent");
  await mkdir(agentDir);
  const settingsManager = SettingsManager.inMemory();
  settingsManager.setProjectTrusted(true);
  const loader = new DefaultResourceLoader({ cwd: workspace.cwd, agentDir, settingsManager, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const names = loaded.extensions.flatMap((extension) => [...extension.tools.keys()]);
  for (const name of ["office_inventory", "office_reconcile", "office_report"]) assert.ok(names.includes(name), `${name} must be discovered`);
  assert.ok(loader.getSkills().skills.some((skill) => skill.name === "workagent-office"));
});

test("workspace and input checks reject escapes and arbitrary cwd", async (t) => {
  const workspace = await fixture(t);
  assert.equal(await validateWorkspace(workspace.cwd, workspace.root), workspace.cwd);
  await assert.rejects(validateWorkspace(workspace.root, workspace.root), { code: "PATH_DENIED" });
  await assert.rejects(validateWorkspace(path.join(workspace.cwd, "outputs"), workspace.root), { code: "PATH_DENIED" });
  for (const input of ["../outside.csv", "a/../基准.csv", "C:\\secrets.csv", "基准.csv:stream"]) {
    await assert.rejects(resolveInputFile(input, workspace.cwd), { code: "PATH_DENIED" });
  }
  assert.equal(await resolveInputFile("基准.csv", workspace.cwd), "基准.csv");
  assert.equal(await resolveInputFile(".", workspace.cwd, true), ".");
  await assert.rejects(resolveInputFile(".", workspace.cwd), { code: "INPUT_NOT_FOUND" });
  await assert.rejects(resolveInputFile("missing.csv", workspace.cwd), { code: "INPUT_NOT_FOUND" });
});

test("artifacts report actual files and enforce count limits", async (t) => {
  const workspace = await fixture(t);
  await mkdir(path.join(workspace.outputDir, "run"));
  await writeFile(path.join(workspace.outputDir, "run", "report.md"), "# report\n");
  await writeFile(path.join(workspace.outputDir, "run", "data.csv"), "id\n001\n");
  const listing = await listArtifacts(workspace.cwd, workspace.root, 1);
  assert.equal(listing.artifacts.length, 1);
  assert.equal(listing.truncated, true);
  assert.ok(listing.artifacts[0].size > 0);
  assert.ok(path.isAbsolute(listing.artifacts[0].path));
});

test("artifact listing excludes links outside the managed workspace", async (t) => {
  const workspace = await fixture(t);
  const outside = path.join(workspace.root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "secret");
  await symlink(outside, path.join(workspace.outputDir, "outside-link"), process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual((await listArtifacts(workspace.cwd, workspace.root)).artifacts, []);
  await assert.rejects(resolveInputFile("outputs/outside-link/secret.txt", workspace.cwd), { code: "INPUT_NOT_FOUND" });
});

test("office requests reject unknown operations and malformed payloads", () => {
  assert.throws(() => parseOfficeRequest({ operation: "shell" }), { code: "INVALID_OPERATION" });
  assert.throws(() => parseOfficeRequest({ operation: "report", inputs: [1] }), { code: "INVALID_INPUTS" });
  assert.throws(() => parseOfficeRequest({ operation: "report", options: [] }), { code: "INVALID_OPTIONS" });
  assert.equal(parseOfficeRequest({ operation: "inventory" }).operation, "inventory");
});
