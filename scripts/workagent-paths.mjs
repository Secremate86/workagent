import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// One-time, local migration. Never follow links or overwrite a newer file.
// Keep the original trees as backups, rather than deleting user configuration.
function copyTree(source, target) {
  const info = lstatSync(source);
  if (info.isSymbolicLink()) throw new Error(`配置迁移拒绝符号链接：${source}`);
  if (info.isDirectory()) {
    if (existsSync(target) && (!lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink())) throw new Error(`配置迁移目标不是普通目录：${target}`);
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source)) copyTree(path.join(source, entry), path.join(target, entry));
  } else if (info.isFile()) {
    if (existsSync(target)) {
      if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile() || !readFileSync(source).equals(readFileSync(target))) {
        throw new Error(`新旧配置存在冲突，请先合并文件：${target}`);
      }
    } else copyFileSync(source, target, constants.COPYFILE_EXCL);
  } else throw new Error(`配置迁移仅支持普通文件：${source}`);
}

export function prepareWorkAgentPaths(root) {
  root = path.resolve(root);
  if (realpathSync(root) !== root) throw new Error("配置迁移项目不能通过符号链接访问");
  const dataRoot = path.join(root, ".workagent");
  if (existsSync(dataRoot) && (lstatSync(dataRoot).isSymbolicLink() || !lstatSync(dataRoot).isDirectory())) throw new Error("WorkAgent 数据目录必须是普通目录");
  mkdirSync(dataRoot, { recursive: true });
  const marker = path.join(dataRoot, "namespace-migration-v1.json");
  const agentDir = path.join(dataRoot, "agent");
  if (!existsSync(marker)) {
    const migrations = [
      [path.join(dataRoot, "pi-agent"), agentDir, "agent-config"],
      [path.join(root, ".pi"), dataRoot, "project-config"],
      [path.join(dataRoot, "workspace", ".pi"), path.join(dataRoot, "workspace", ".workagent"), "workspace-config"],
    ];
    const backupRoot = path.join(dataRoot, "migration-backups");
    for (const directory of [path.join(dataRoot, "workspace"), backupRoot]) {
      if (existsSync(directory) && (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())) throw new Error(`配置迁移目录必须是普通目录：${directory}`);
    }
    for (const [source, target, name] of migrations) {
      if (!existsSync(source)) continue;
      // All computed sources and backups must stay in this project.
      if (path.relative(root, source).startsWith("..") || path.relative(root, target).startsWith("..")) throw new Error("配置迁移超出项目范围");
      copyTree(source, target);
      mkdirSync(backupRoot, { recursive: true });
      const backup = path.join(backupRoot, name);
      if (existsSync(backup)) throw new Error(`迁移备份已存在：${backup}`);
      renameSync(source, backup);
    }
    // Only JSONL header metadata holds session ancestry; leave chat content intact.
    const oldAgentDir = path.join(dataRoot, "pi-agent");
    function updateHeaders(directory) {
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) updateHeaders(file);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          const text = readFileSync(file, "utf8");
          const end = text.indexOf("\n");
          if (end < 0) continue;
          const header = JSON.parse(text.slice(0, end));
          if (typeof header.parentSession === "string" && header.parentSession.startsWith(`${oldAgentDir}${path.sep}`)) {
            header.parentSession = agentDir + header.parentSession.slice(oldAgentDir.length);
            writeFileSync(file, JSON.stringify(header) + text.slice(end), { mode: 0o600 });
          }
        }
      }
    }
    updateHeaders(path.join(agentDir, "sessions"));
    writeFileSync(marker, JSON.stringify({ version: 1, completedAt: new Date().toISOString() }) + "\n", { flag: "wx", mode: 0o600 });
  }
  mkdirSync(agentDir, { recursive: true });
  return { agentDir };
}
