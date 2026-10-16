import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const { installWorkAgentSkills } = await jiti.import("./workagent-skill-install.ts");
const { annotateSkillsWithInstallInfo } = await jiti.import("./skill-lock.ts");
const { checkSkillUpdate } = await jiti.import("./skill-updates.ts");

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "workagent-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project"), agentDir = path.join(root, "agent");
  await mkdir(cwd); await mkdir(agentDir);
  return { cwd, agentDir, globalLockPath: path.join(root, "lock.json"), args: ["skills", "add", "owner/repo@sample", "-y", "--agent", "pi"] };
}

async function stage(args, cwd) {
  assert.ok(args.includes("--copy"));
  assert.ok(!args.includes("-g"));
  const skill = path.join(cwd, ".pi/skills/sample");
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "---\nname: sample\ndescription: Sample skill\n---\nUse sample.\n");
  await writeFile(path.join(cwd, "skills-lock.json"), JSON.stringify({ version: 1, skills: { sample: { source: "owner/repo", sourceType: "github", skillPath: "skills/sample/SKILL.md", computedHash: "snapshot-hash" } } }));
  return { stdout: "Installed 1 skill into .pi", stderr: "" };
}

for (const scope of ["project", "global"]) test(`${scope} install is actually discovered in WorkAgent and retains update metadata`, async t => {
  const options = await fixture(t);
  const result = await installWorkAgentSkills({ ...options, scope, runCli: stage });
  assert.deepEqual(result.installed, ["sample"]);
  assert.ok(!result.stdout.includes(".pi"));
  const settingsManager = SettingsManager.inMemory(); settingsManager.setProjectTrusted(true);
  const loader = new DefaultResourceLoader({ cwd: options.cwd, agentDir: options.agentDir, settingsManager, noExtensions: true, noThemes: true, noContextFiles: true, noPromptTemplates: true });
  await loader.reload();
  const loaded = loader.getSkills().skills.find(skill => skill.name === "sample");
  assert.ok(loaded);
  assert.equal(loaded.filePath, path.join(scope === "global" ? options.agentDir : path.join(options.cwd, ".workagent"), "skills/sample/SKILL.md"));
  const [annotated] = annotateSkillsWithInstallInfo([loaded], { ...options });
  assert.equal(annotated.install.canCheckForUpdates, true);
  const check = await checkSkillUpdate(annotated.install, { fetcher: async url => {
    assert.ok(String(url).includes("/api/download/"));
    return new Response(JSON.stringify({ hash: "snapshot-hash" }));
  } });
  assert.equal(check.state, "up-to-date");
});

test("a corrupt lock is preserved before any installed skill is replaced", async t => {
  const options = await fixture(t);
  await writeFile(options.globalLockPath, "broken lock");
  await assert.rejects(installWorkAgentSkills({ ...options, scope: "global", runCli: stage }), /锁文件损坏/);
  assert.equal(await readFile(options.globalLockPath, "utf8"), "broken lock");
  await assert.rejects(readFile(path.join(options.agentDir, "skills/sample/SKILL.md")), { code: "ENOENT" });
});

test("staged links are refused instead of installing broken references", async t => {
  const options = await fixture(t);
  await assert.rejects(installWorkAgentSkills({ ...options, scope: "project", runCli: async (args, cwd) => {
    const result = await stage(args, cwd);
    await symlink(options.agentDir, path.join(cwd, ".pi/skills/sample/external"), process.platform === "win32" ? "junction" : "dir");
    return result;
  } }), /符号链接/);
});
