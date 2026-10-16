import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { prepareWorkAgentPaths } from './workagent-paths.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { agentDir } = prepareWorkAgentPaths(root);
mkdirSync(agentDir, { recursive: true });
const child = spawn(process.execPath, ['--import', pathToFileURL(resolve(root, 'scripts/workagent-sdk-hooks.mjs')).href, resolve(root, 'node_modules/next/dist/bin/next'), 'dev', '-H', '127.0.0.1', '-p', '30141'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR || agentDir, PI_WEB_APP_NAME: 'WorkAgent',
    NEXT_TELEMETRY_DISABLED: '1', UV_CACHE_DIR: resolve(root, '.workagent/uv-cache'),
    PI_MEMORY_DIR: resolve(root, '.workagent/memory'),
    PI_MEMORY_EXIT_SUMMARY: 'off', PI_MEMORY_SUMMARIZE_TRANSITIONS: '0',
    PI_MEMORY_QMD_UPDATE: 'off', PI_MEMORY_NO_SEARCH: '1',
  },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));
