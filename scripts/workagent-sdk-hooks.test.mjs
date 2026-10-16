import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import './workagent-sdk-hooks.mjs';

test('Pi SDK config and project resources use .workagent', async () => {
  const { CONFIG_DIR_NAME, SettingsManager, DefaultResourceLoader } = await import('@earendil-works/pi-coding-agent');
  assert.equal(CONFIG_DIR_NAME, '.workagent');

  const root = await mkdtemp(join(tmpdir(), 'workagent-sdk-'));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  const skillDir = join(cwd, '.workagent', 'skills', 'hook-check');
  const extensionDir = join(cwd, '.workagent', 'extensions');
  await mkdir(skillDir, { recursive: true });
  await mkdir(extensionDir, { recursive: true });
  await writeFile(join(cwd, '.workagent', 'settings.json'), JSON.stringify({ defaultThinkingLevel: 'high' }));
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: hook-check\ndescription: SDK namespace check\n---\nUse this skill.\n');
  await writeFile(join(extensionDir, 'hook-check.js'), 'module.exports = function hookCheck() {}\n');

  try {
    const settings = SettingsManager.create(cwd, agentDir);
    assert.equal(settings.getProjectSettings().defaultThinkingLevel, 'high');

    const resources = new DefaultResourceLoader({ cwd, agentDir });
    await resources.reload();
    assert.ok(resources.getSkills().skills.some(skill => skill.name === 'hook-check'));
    assert.ok(resources.getExtensions().extensions.some(extension =>
      String(extension.path ?? extension.source ?? '').includes(join('.workagent', 'extensions'))));
    assert.equal(resources.getExtensions().errors.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
