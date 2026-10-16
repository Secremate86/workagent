import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { prepareWorkAgentPaths } from "./workagent-paths.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const { agentDir } = prepareWorkAgentPaths(root);
const child = spawn(process.execPath, [
  "--import", pathToFileURL(path.join(root, "scripts/workagent-sdk-hooks.mjs")).href,
  path.join(root, "node_modules/next/dist/bin/next"), "start", "-H", "0.0.0.0", "-p", "30141",
], {
  cwd: root, stdio: "inherit",
  env: {
    ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", PI_WEB_APP_NAME: "WorkAgent",
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR || agentDir,
    PI_MEMORY_DIR: process.env.PI_MEMORY_DIR || path.join(root, ".workagent/memory"),
    PI_MEMORY_EXIT_SUMMARY: "off", PI_MEMORY_SUMMARIZE_TRANSITIONS: "0", PI_MEMORY_QMD_UPDATE: "off", PI_MEMORY_NO_SEARCH: "1",
  },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.once("error", error => { console.error(error.message); process.exit(1); });
child.once("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
