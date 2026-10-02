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
const piPackageDir = join(process.env.APPDATA, 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist');
const { initTheme } = await import(pathToFileURL(join(piPackageDir, 'index.js')).href);

test('/wm-settings cycles Codemode through on, only, and off', async () => {
  const previousProfile = process.env.USERPROFILE;
  const profile = previousProfile || process.env.HOME;
  const tempRoot = join(profile, 'Temp');
  const tempRootExisted = existsSync(tempRoot);
  mkdirSync(tempRoot, { recursive: true });
  const testHome = mkdtempSync(join(tempRoot, 'pi-workspace-manager-codemode-'));

  try {
    process.env.USERPROFILE = testHome;
    const agentDir = join(testHome, '.pi', 'agent');
    const workspace = join(testHome, 'workspace');
    mkdirSync(join(agentDir), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
      codemode: { mode: 'on' },
      'pi-workspace-manager': { codemode: { mode: 'on' } },
    }));

    initTheme();
    const loaded = await discoverAndLoadExtensions([join(pluginDir, 'index.ts')], pluginDir, pluginDir);
    assert.deepEqual(loaded.errors, []);
    const command = loaded.extensions[0].commands.get('wm-settings');
    assert.equal(typeof command?.handler, 'function');

    let activeTools = ['read', 'edit'];
    loaded.runtime.getActiveTools = () => activeTools;
    loaded.runtime.setActiveTools = (tools) => { activeTools = tools; };
    const notifications = [];
    const theme = { fg: (_color, value) => value, bold: (value) => value };
    const tui = { requestRender() {} };

    const cycleCodemode = async () => command.handler('', {
      mode: 'tui',
      cwd: workspace,
      ui: {
        notify: (message) => notifications.push(message),
        custom: async (factory) => new Promise((resolve) => {
          const view = factory(tui, theme, {}, resolve);
          for (const character of 'Codemode') view.handleInput(character);
          view.handleInput('\r');
          view.handleInput('\x1b');
        }),
      },
    });

    await cycleCodemode();
    let settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'));
    assert.equal(settings.codemode.mode, 'only');
    assert.equal(settings['pi-workspace-manager'].codemode.mode, 'only');
    assert.ok(activeTools.includes('codemode'));

    await cycleCodemode();
    settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'));
    assert.equal(settings['pi-workspace-manager'].codemode.mode, 'off');
    assert.equal(settings.codemode.mode, 'only', 'off is a manager-level state, not a Pi codemode.mode value');
    assert.ok(!activeTools.includes('codemode'));

    await cycleCodemode();
    settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'));
    assert.equal(settings.codemode.mode, 'on');
    assert.equal(settings['pi-workspace-manager'].codemode.mode, 'on');
    assert.ok(activeTools.includes('codemode'));
    assert.ok(notifications.every((message) => message.includes('/reload')));
  } finally {
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
    rmSync(testHome, { recursive: true, force: true });
    if (!tempRootExisted) rmSync(tempRoot, { recursive: true, force: true });
  }
});
