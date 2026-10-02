import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const pluginDir = join(import.meta.dirname, '..');
const chunksDir = join(process.env.APPDATA, 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'chunks');
const chunk = readdirSync(chunksDir).find((name) => name.endsWith('.js') &&
  readFileSync(join(chunksDir, name), 'utf8').includes('async _runAgentPrompt(messages){'));
assert.ok(chunk, 'Installed Pi bundle is not available');
const { discoverAndLoadExtensions } = await import(pathToFileURL(join(chunksDir, chunk)).href);

test('/plugins shows Git source variants once and consolidates them on state change', async () => {
  const previousProfile = process.env.USERPROFILE;
  const profile = previousProfile || process.env.HOME;
  const tempRoot = join(profile, 'Temp');
  const tempRootExisted = existsSync(tempRoot);
  mkdirSync(tempRoot, { recursive: true });
  const testHome = mkdtempSync(join(tempRoot, 'pi-workspace-manager-'));

  try {
    process.env.USERPROFILE = testHome;
    const agentDir = join(testHome, '.pi', 'agent');
    const gitDir = join(agentDir, 'git', 'github.com', 'acme');
    const workspace = join(testHome, 'workspace');
    const otherWorkspace = join(testHome, 'other-workspace');
    const otherSession = join(agentDir, 'sessions', 'other-workspace-session');
    mkdirSync(join(gitDir, 'sample-plugin'), { recursive: true });
    mkdirSync(join(gitDir, 'sample-plugin@main'), { recursive: true });
    mkdirSync(join(workspace, '.pi'), { recursive: true });
    mkdirSync(join(otherWorkspace, '.pi'), { recursive: true });
    mkdirSync(otherSession, { recursive: true });
    for (const directory of ['sample-plugin', 'sample-plugin@main']) {
      writeFileSync(join(gitDir, directory, 'package.json'), JSON.stringify({
        name: 'sample-plugin',
        repository: 'https://github.com/acme/sample-plugin.git',
      }));
    }
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
      packages: ['git:github.com/acme/sample-plugin', 'git:github.com/acme/sample-plugin@main'],
    }));
    writeFileSync(join(workspace, '.pi', 'settings.json'), JSON.stringify({
      packages: ['git:github.com/acme/sample-plugin@main'],
    }));
    writeFileSync(join(otherWorkspace, '.pi', 'settings.json'), JSON.stringify({
      packages: ['git:github.com/acme/sample-plugin@main'],
    }));
    writeFileSync(join(otherSession, 'session.meta.json'), JSON.stringify({ cwd: otherWorkspace }));

    const loaded = await discoverAndLoadExtensions([join(pluginDir, 'index.ts')], pluginDir, pluginDir);
    assert.deepEqual(loaded.errors, []);
    const command = loaded.extensions[0].commands.get('plugins');
    assert.equal(typeof command?.handler, 'function');

    let rendered = '';
    const theme = { fg: (_color, value) => value, bold: (value) => value };
    const tui = { requestRender() {} };
    const openAndSelect = (key) => command.handler('', {
      cwd: workspace,
      ui: {
        notify() {},
        custom: async (factory) => new Promise((resolve) => {
          const view = factory(tui, theme, {}, resolve);
          rendered = view.render(100).join('\n');
          if (key === null) resolve(false);
          else {
            view.handleInput(key);
            view.handleInput('\r');
          }
        }),
      },
    });

    await openAndSelect(null);
    let globalSettings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'));
    assert.equal(globalSettings.packages.length, 1, 'opening the manager should consolidate global aliases');
    let workspaceSettings = JSON.parse(readFileSync(join(workspace, '.pi', 'settings.json'), 'utf8'));
    assert.deepEqual(workspaceSettings.packages, [], 'global wins over current-workspace duplicates even when cancelled');
    let otherWorkspaceSettings = JSON.parse(readFileSync(join(otherWorkspace, '.pi', 'settings.json'), 'utf8'));
    assert.deepEqual(otherWorkspaceSettings.packages, ['git:github.com/acme/sample-plugin@main'],
      'opening the manager must leave other workspaces untouched');

    await openAndSelect('1');
    assert.equal((rendered.match(/sample-plugin/g) || []).length, 1, 'duplicate source variants should render as one row');
    globalSettings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'));
    assert.equal(globalSettings.packages.length, 1, 'global settings should contain one canonical registration');
    workspaceSettings = JSON.parse(readFileSync(join(workspace, '.pi', 'settings.json'), 'utf8'));
    assert.deepEqual(workspaceSettings.packages, [], 'global registration should remove current-workspace duplicates');
    otherWorkspaceSettings = JSON.parse(readFileSync(join(otherWorkspace, '.pi', 'settings.json'), 'utf8'));
    assert.deepEqual(otherWorkspaceSettings.packages, ['git:github.com/acme/sample-plugin@main'],
      'other workspaces are independent and must remain unchanged');

    await openAndSelect('2');
    globalSettings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'));
    workspaceSettings = JSON.parse(readFileSync(join(workspace, '.pi', 'settings.json'), 'utf8'));
    assert.deepEqual(globalSettings.packages, [], 'workspace registration should remove its global counterpart');
    assert.equal(workspaceSettings.packages.length, 1, 'current workspace should retain exactly one active registration');
    otherWorkspaceSettings = JSON.parse(readFileSync(join(otherWorkspace, '.pi', 'settings.json'), 'utf8'));
    assert.deepEqual(otherWorkspaceSettings.packages, ['git:github.com/acme/sample-plugin@main'],
      'workspace transitions must leave other workspaces untouched');

    await openAndSelect('3');
    globalSettings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'));
    workspaceSettings = JSON.parse(readFileSync(join(workspace, '.pi', 'settings.json'), 'utf8'));
    assert.deepEqual(globalSettings.packages, [], 'removing a workspace registration must not create a global one');
    assert.deepEqual(workspaceSettings.packages, [], 'remove should clear current-workspace active refs');
    assert.equal(workspaceSettings._disabledPackages.length, 1, 'remove should leave one disabled registration');
    otherWorkspaceSettings = JSON.parse(readFileSync(join(otherWorkspace, '.pi', 'settings.json'), 'utf8'));
    assert.deepEqual(otherWorkspaceSettings.packages, ['git:github.com/acme/sample-plugin@main'],
      'remove must leave other workspaces untouched');
  } finally {
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
    rmSync(testHome, { recursive: true, force: true });
    if (!tempRootExisted) rmSync(tempRoot, { recursive: true, force: true });
  }
});
