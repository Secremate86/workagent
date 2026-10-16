import { constants, realpathSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { hasParentDirectorySegment, isExistingPathWithinRoots } from "../path-security";
import { writePrivateFileAtomicSync } from "../atomic-file";

export const UPSTREAM = {
  name: "agegr/pi-web",
  version: "0.12.1",
  commit: "ac54e0153277d09a38ec1ef116a9f1f1c788765c",
} as const;

export class OfficeError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = "OfficeError";
  }
}

export function projectRoot(root = process.cwd()): string {
  return path.resolve(root);
}

export function workspacePath(root = process.cwd()): string {
  return path.join(projectRoot(root), ".workagent", "workspace");
}

async function managedDirectory(directory: string, parent: string) {
  await mkdir(directory, { recursive: true });
  if (!isExistingPathWithinRoots(directory, new Set([parent]))) {
    throw new OfficeError("PATH_DENIED", "工作区目录指向管理范围之外", 403);
  }
}

/** Install only our own extension and skill in this workspace, without touching user Pi settings. */
export async function ensureWorkspace(root = process.cwd()) {
  const repo = projectRoot(root);
  const dataRoot = path.join(repo, ".workagent");
  const cwd = workspacePath(repo);
  await managedDirectory(dataRoot, repo);
  await managedDirectory(cwd, dataRoot);
  const outputDir = path.join(cwd, "outputs");
  await managedDirectory(outputDir, cwd);
  const piDir = path.join(cwd, ".workagent");
  await managedDirectory(piDir, cwd);
  const extensionsDir = path.join(piDir, "extensions");
  await managedDirectory(extensionsDir, piDir);
  const skillsDir = path.join(piDir, "skills");
  await managedDirectory(skillsDir, piDir);
  const officeSkillDir = path.join(skillsDir, "workagent-office");
  await managedDirectory(officeSkillDir, skillsDir);
  const extensionRelativePath = path.relative(extensionsDir, path.join(repo, "extensions", "workagent-office")).split(path.sep).join("/");
  writePrivateFileAtomicSync(path.join(extensionsDir, "workagent-office.ts"), `export { default } from ${JSON.stringify(extensionRelativePath)};\n`);
  writePrivateFileAtomicSync(path.join(officeSkillDir, "SKILL.md"), await readFile(path.join(repo, "resources", "workagent-office", "SKILL.md"), "utf8"));

  const exampleInputs: string[] = [];
  const examplesDir = path.join(repo, "examples", "office");
  const examples = await readdir(examplesDir, { withFileTypes: true }).catch(() => []);
  const priority = (name: string) => name === "基准.csv" ? 0 : name === "对比.csv" ? 1 : 2;
  for (const entry of examples.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csv")).sort((a, b) => priority(a.name) - priority(b.name) || a.name.localeCompare(b.name)).slice(0, 20)) {
    const target = path.join(cwd, entry.name);
    try {
      await copyFile(path.join(examplesDir, entry.name), target, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (isExistingPathWithinRoots(target, new Set([cwd]))) exampleInputs.push(entry.name);
  }
  return { cwd: realpathSync(cwd), outputDir: realpathSync(outputDir), exampleInputs, upstream: UPSTREAM };
}

/** The API is scoped to the dedicated workspace, never an arbitrary caller-supplied cwd. */
export async function validateWorkspace(cwd: string, root = process.cwd()): Promise<string> {
  const expected = workspacePath(root);
  if (!cwd || hasParentDirectorySegment(cwd) || !isExistingPathWithinRoots(expected, new Set([projectRoot(root)])) || !isExistingPathWithinRoots(cwd, new Set([expected]))) {
    throw new OfficeError("PATH_DENIED", "仅支持 WorkAgent 管理的工作区", 403);
  }
  const resolved = realpathSync(cwd);
  const expectedReal = realpathSync(expected);
  if (path.relative(expectedReal, resolved) !== "") {
    throw new OfficeError("PATH_DENIED", "请选择 WorkAgent 工作区根目录", 403);
  }
  return resolved;
}

export async function resolveInputFile(input: string, cwd: string, allowDirectory = false): Promise<string> {
  if (!input || input.includes("\0") || hasParentDirectorySegment(input) || path.isAbsolute(input)
      || /^[a-z]:/i.test(input) || input.startsWith("\\") || input.includes(":")) {
    throw new OfficeError("PATH_DENIED", "输入必须是工作区内的相对文件路径", 403);
  }
  const target = path.resolve(cwd, input);
  const allowed = isExistingPathWithinRoots(target, new Set([cwd]));
  const info = allowed ? await stat(target) : undefined;
  if (!info || (!info.isFile() && !(allowDirectory && info.isDirectory()))) {
    throw new OfficeError("INPUT_NOT_FOUND", `工作区内找不到输入文件：${input}`);
  }
  return path.relative(cwd, realpathSync(target)) || ".";
}

export interface OfficeArtifact {
  path: string;
  name: string;
  mime: string;
  size: number;
  modified: string;
}

function mimeType(filename: string): string {
  const types: Record<string, string> = {
    ".csv": "text/csv", ".tsv": "text/tab-separated-values", ".json": "application/json",
    ".md": "text/markdown", ".txt": "text/plain", ".html": "text/html",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pdf": "application/pdf",
  };
  return types[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
}

export async function describeArtifact(file: string, outputDir: string): Promise<OfficeArtifact> {
  if (!isExistingPathWithinRoots(file, new Set([outputDir]))) {
    throw new OfficeError("PATH_DENIED", "产物路径超出输出目录", 403);
  }
  const info = await stat(file);
  if (!info.isFile()) throw new OfficeError("INVALID_ARTIFACT", "产物不是文件", 502);
  const canonicalPath = realpathSync(file);
  return { path: canonicalPath, name: path.basename(canonicalPath), mime: mimeType(file), size: info.size, modified: info.mtime.toISOString() };
}

export async function listArtifacts(cwd: string, root = process.cwd(), limit = 100) {
  const workspace = await validateWorkspace(cwd, root);
  const outputDir = path.join(workspace, "outputs");
  if (!isExistingPathWithinRoots(outputDir, new Set([workspace]))) {
    throw new OfficeError("PATH_DENIED", "输出目录超出工作区", 403);
  }
  const maxItems = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 100, 100));
  const artifacts: OfficeArtifact[] = [];
  let inspected = 0;
  let truncated = false;
  const directories = [outputDir];
  while (directories.length && !truncated) {
    const directory = directories.shift()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++inspected > 1000 || artifacts.length >= maxItems) { truncated = true; break; }
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || !isExistingPathWithinRoots(file, new Set([outputDir]))) continue;
      if (entry.isDirectory()) directories.push(file);
      else if (entry.isFile()) artifacts.push(await describeArtifact(file, outputDir));
    }
  }
  artifacts.sort((a, b) => b.modified.localeCompare(a.modified));
  return { cwd: workspace, artifacts, truncated, limit: maxItems };
}
