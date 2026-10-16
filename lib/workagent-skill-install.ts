import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { SkillInstallScope } from "@/lib/api-types";
import { serializeByKey } from "./key-serializer";
import { writePrivateFileAtomicSync } from "./atomic-file";

interface SkillLockEntry {
  [key: string]: unknown;
}

interface SkillLockFile {
  version?: number;
  skills?: Record<string, SkillLockEntry>;
  [key: string]: unknown;
}

export interface WorkAgentSkillInstallOptions {
  args: string[];
  scope: SkillInstallScope;
  cwd: string;
  agentDir: string;
  globalLockPath: string;
  runCli: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
  /** Restrict replacement to a specific installed skill, as used by updates. */
  skillNames?: string[];
}

export interface WorkAgentSkillInstallResult {
  stdout: string;
  stderr: string;
  installed: string[];
}

const INSTALL_LOCK = Symbol.for("workagent.skill-install");

async function regularTree(file: string): Promise<void> {
  const info = await lstat(file);
  if (info.isSymbolicLink()) throw new Error("技能目录不支持符号链接");
  if (info.isDirectory()) {
    for (const name of await readdir(file)) await regularTree(join(file, name));
  } else if (!info.isFile()) throw new Error("技能目录仅支持普通文件");
}

async function checkAncestors(file: string): Promise<void> {
  file = resolve(file);
  const parent = dirname(file);
  if (parent !== file) await checkAncestors(parent);
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error("技能安装路径不支持符号链接");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function readLock(path: string): Promise<SkillLockFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("技能锁文件损坏，已停止写入");
    const lock = parsed as SkillLockFile;
    return lock.skills && typeof lock.skills === "object" && !Array.isArray(lock.skills)
      ? lock
      : (() => { throw new Error("技能锁文件损坏，已停止写入"); })();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw new Error("技能锁文件损坏，已停止写入");
    throw error;
  }
}

async function mergeLockFile(
  stagedPath: string,
  targetPath: string,
  skillNames: string[],
  global: boolean,
): Promise<void> {
  const staged = await readLock(stagedPath);
  if (!staged?.skills) return;
  const current = await readLock(targetPath) ?? { version: staged.version ?? 1, skills: {} };
  const currentEntries = current.skills ?? {};
  const stagedNames = Object.keys(staged.skills);
  const wanted = new Set(skillNames.map(name => name.toLowerCase()));
  const matching = stagedNames.filter(name => wanted.has(name.toLowerCase()));

  for (const name of matching) currentEntries[name] = { ...staged.skills[name], ...(global ? { workagentHashKind: "snapshot" } : {}) };
  if (matching.length === 0) return;

  current.skills = currentEntries;
  await mkdir(join(targetPath, ".."), { recursive: true });
  writePrivateFileAtomicSync(targetPath, `${JSON.stringify(current, null, 2)}\n`);
}

async function replaceSkillDirectory(source: string, target: string): Promise<void> {
  const parent = join(target, "..");
  await mkdir(parent, { recursive: true });
  const suffix = `${process.pid}-${Math.random().toString(16).slice(2)}`;
  const incoming = `${target}.${suffix}.incoming`;
  const backup = `${target}.${suffix}.backup`;
  await cp(source, incoming, { recursive: true, force: false, errorOnExist: true });

  let backedUp = false;
  try {
    if (await isDirectory(target)) {
      await rename(target, backup);
      backedUp = true;
    }
    await rename(incoming, target);
    if (backedUp) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(incoming, { recursive: true, force: true });
    if (backedUp && !(await isDirectory(target))) await rename(backup, target);
    throw error;
  }
}

export async function installWorkAgentSkills(options: WorkAgentSkillInstallOptions): Promise<WorkAgentSkillInstallResult> {
  // A global lock can be shared by several project windows.
  const key = options.scope === "global" ? resolve(options.globalLockPath) : resolve(options.cwd);
  return serializeByKey(INSTALL_LOCK, key, () => installSkills(options));
}

async function installSkills({
  args,
  scope,
  cwd,
  agentDir,
  globalLockPath,
  runCli,
  skillNames,
}: WorkAgentSkillInstallOptions): Promise<WorkAgentSkillInstallResult> {
  const stageRoot = await mkdtemp(join(tmpdir(), "workagent-skills-"));
  try {
    const safeArgs = args.filter(arg => arg !== "-g" && arg !== "--global");
    if (safeArgs[2]?.startsWith("./") || safeArgs[2]?.startsWith("../") || safeArgs[2]?.startsWith(".\\") || safeArgs[2]?.startsWith("..\\")) safeArgs[2] = resolve(cwd, safeArgs[2]);
    if (!safeArgs.includes("--copy")) safeArgs.push("--copy");
    await runCli(safeArgs, stageRoot);

    // The actual Skills CLI's `--agent pi --copy` project target is .pi/skills.
    const stageSkills = join(stageRoot, ".pi", "skills");
    if (!(await isDirectory(stageSkills))) {
      throw new Error("技能安装器没有生成有效技能目录");
    }

    const targetSkills = scope === "project"
      ? join(cwd, ".workagent", "skills")
      : join(agentDir, "skills");
    const names = skillNames?.length ? skillNames : undefined;
    const lockPath = scope === "project" ? join(cwd, "skills-lock.json") : globalLockPath;
    await checkAncestors(targetSkills);
    await checkAncestors(lockPath);
    // Refuse corrupt metadata before replacing any installed directory.
    await readLock(lockPath);
    await readLock(join(stageRoot, "skills-lock.json"));
    const installed: string[] = [];
    const entries = await readdir(stageSkills, { withFileTypes: true });
    const selected = entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && (!names || names.some(name => name.toLowerCase() === entry.name.toLowerCase())));
    for (const entry of selected) {
      const source = join(stageSkills, entry.name);
      await regularTree(source);
      if (!(await lstat(join(source, "SKILL.md"))).isFile()) throw new Error("技能缺少有效的 SKILL.md");
    }
    for (const entry of selected) {
      const source = join(stageSkills, entry.name);
      try {
        await lstat(join(source, "SKILL.md"));
      } catch {
        continue;
      }
      await replaceSkillDirectory(source, join(targetSkills, entry.name));
      installed.push(entry.name);
    }
    if (installed.length === 0) throw new Error("Skills CLI did not stage any matching SKILL.md files");

    const stagedLock = join(stageRoot, "skills-lock.json");
    await mergeLockFile(stagedLock, lockPath, installed, scope === "global");

    return { stdout: `WorkAgent 已安装 ${installed.length} 个技能至 ${targetSkills}`, stderr: "", installed };
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
}
