import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const pluginDir = join(import.meta.dirname, '..');
const chunksDir = join(process.env.APPDATA, 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'chunks');
const files = readdirSync(chunksDir);
const { createJiti } = await import(pathToFileURL(join(chunksDir, files.find((n) => /^jiti-static-loader.*\.js$/.test(n)))).href);
const { VIRTUAL_MODULES } = await import(pathToFileURL(join(chunksDir, files.find((n) => /^virtual-modules.*\.js$/.test(n)))).href);
const sdk = VIRTUAL_MODULES['@earendil-works/pi-coding-agent'];
const tui = VIRTUAL_MODULES['@earendil-works/pi-tui'];
const module = await createJiti(import.meta.url, { moduleCache: false, tryNative: false, virtualModules: VIRTUAL_MODULES }).import(join(pluginDir, 'index.ts'));
const { formatInteractionTime, appendInteractionTime, putInteractionTimeInTool, installInteractionTimestampRenderers, turnTimestampTarget } = module;
const chunk = files.find((n) => n.endsWith('.js') && readFileSync(join(chunksDir, n), 'utf8').includes('async _runAgentPrompt(messages){'));
const { discoverAndLoadExtensions, SessionManager } = await import(pathToFileURL(join(chunksDir, chunk)).href);
sdk.initTheme('dark', false);
// Use Pi's ACTUAL shell renderers, not a fixture Text('Took ...'). They own
// startedAt/endedAt and therefore expose live-vs-rebuilt history regressions.
const distDir = join(chunksDir, '..', '..');
const nativeSdk = await import(pathToFileURL(join(distDir, 'index.js')).href);
nativeSdk.initTheme('dark', false);
const { createShellRenderers } = await import(pathToFileURL(join(distDir, 'core', 'tools', 'renderers', 'bash.js')).href);
function nativeShell(id, name = 'bash') {
  const definition = { ...sdk.createBashTool(pluginDir), ...createShellRenderers(name === 'powershell' ? 'PS>' : '$') };
  return new sdk.ToolExecutionComponent(name, id, { command: 'echo ok' }, { showImages: false }, definition, { requestRender() {} }, pluginDir);
}
const renderedText = (component) => component.render(70).map(tui.stripTerminalSequences).join('\n');

const at = new Date(2026, 9, 3, 9, 7, 45).getTime();
const today = new Date(2026, 9, 3, 20, 0);
const ui = () => ({ theme: { fg: (_name, text) => text }, getEditorComponent: () => undefined, setEditorComponent() {}, requestRender() {}, invalidate() {} });
async function setup(manager = SessionManager.inMemory()) {
  const loaded = await discoverAndLoadExtensions([join(pluginDir, 'index.ts')], pluginDir, pluginDir);
  assert.deepEqual(loaded.errors, []);
  const ext = loaded.extensions[0];
  const records = [];
  loaded.runtime.appendEntry = (kind, data) => { records.push({ kind, data }); manager.appendCustomEntry(kind, data); };
  const ctx = { mode: 'tui', sessionManager: manager, ui: ui() };
  await ext.handlers.get('session_start')[0]({ reason: 'startup' }, ctx);
  return { loaded, ext, ctx, manager, records, finish: (message, toolResults = []) => ext.handlers.get('turn_end')[0]({ message, toolResults }, ctx),
    close: () => ext.handlers.get('session_shutdown')[0]({}, ctx) };
}
function tool(id) {
  const component = new sdk.ToolExecutionComponent('read', id, { path: 'example.txt' }, { showImages: false }, undefined, { requestRender() {} }, pluginDir);
  component.updateResult({ content: [{ type: 'text', text: 'Native tool output' }], isError: false });
  return component;
}

test('today shows HH:mm:ss; other local dates show YYYY-MM-DD HH:mm:ss', () => {
  assert.equal(formatInteractionTime(at, today), '09:07:45');
  assert.equal(formatInteractionTime(at, new Date(2026, 9, 4)), '2026-10-03 09:07:45');
  assert.equal(formatInteractionTime(at, new Date(2027, 9, 3)), '2026-10-03 09:07:45');
  assert.equal(formatInteractionTime(NaN, today), '');
});

test('timestamp target is the final tool in display order, or a tool-free assistant reply', () => {
  assert.equal(turnTimestampTarget({ role: 'assistant', timestamp: 1, content: [{ type: 'toolCall', id: 'a' }, { type: 'toolCall', id: 'b' }] }), 'tool:b');
  assert.equal(turnTimestampTarget({ role: 'assistant', timestamp: 1, content: [{ type: 'text', text: 'Reply' }] }), 'assistant:1');
  assert.equal(turnTimestampTarget({ role: 'user', timestamp: 1 }), undefined);
});

test('assistant footer right-aligns without modifying the original body or overflowing narrow terminals', () => {
  const body = ['original body'];
  const lines = appendInteractionTime(body, 30, at, (text) => text, today);
  assert.deepEqual(lines.slice(0, -1), body);
  assert.equal(lines.at(-1), ' '.repeat(21) + '09:07:45 ');
  assert.deepEqual(body, ['original body']);
  for (const width of [0, 1, 3, 5, 8, 12, 25, 80]) {
    assert.ok(tui.visibleWidth(appendInteractionTime([''], width, at, (text) => text, new Date(2026, 9, 4)).at(-1)) <= width);
  }
  assert.deepEqual(appendInteractionTime([], 80, at, (text) => text, today), []);
});

test('selected tool timestamp stays on the bottom padding row, independently of Took output', () => {
  const bg = '\x1b[48;2;30;60;40m';
  const body = [bg + ' output'.padEnd(40) + '\x1b[0m', bg + ' took 2s'.padEnd(40) + '\x1b[0m', bg + ' '.repeat(40) + '\x1b[0m'];
  const rendered = putInteractionTimeInTool(body, 40, at, (text) => '\x1b[2m' + text + '\x1b[22m', today);
  assert.equal(rendered.length, body.length);
  assert.equal(rendered[0], body[0]);
  assert.equal(rendered[1], body[1], 'duration row must remain entirely unchanged');
  assert.equal(tui.stripTerminalSequences(rendered[2]), ' '.repeat(31) + '09:07:45 ');
  assert.ok(rendered[2].startsWith(bg));
  assert.ok(rendered[2].endsWith('\x1b[0m'));
  const narrow = putInteractionTimeInTool(['took 123.456s', ' '.repeat(12)], 12, at, (text) => text, today);
  assert.equal(narrow[0], 'took 123.456s');
  assert.equal(tui.stripTerminalSequences(narrow[1]).trim(), '09:07:45');
});

test('custom shells without padding get a dedicated styled footer, never an inline Took clock', () => {
  const bg = '\x1b[48;2;30;60;40m';
  for (const footer of ['Took 0.4s', 'Elapsed: 2s', 'Ordinary output']) {
    const body = [bg + footer.padEnd(40) + '\x1b[0m'];
    const rendered = putInteractionTimeInTool(body, 40, at, (text) => text, today);
    assert.equal(rendered.length, 2);
    assert.equal(rendered[0], body[0]);
    assert.equal(tui.stripTerminalSequences(rendered[1]), ' '.repeat(31) + '09:07:45 ');
    assert.ok(rendered[1].startsWith(bg));
  }
});

test('real self-rendering tools preserve their Took row and add the clock at the very bottom', () => {
  const component = new sdk.ToolExecutionComponent('custom', 'footer-test', {}, {}, {
    renderShell: 'self',
    renderCall: () => new tui.Text('Native call', 0, 0),
    renderResult: () => new tui.Text('Took 0.4s', 0, 0),
  }, { requestRender() {} }, pluginDir);
  component.updateResult({ content: [{ type: 'text', text: 'Done' }], isError: false });
  const native = component.render(50);
  const timestamp = Date.now();
  const adapter = installInteractionTimestampRenderers({ enabled: () => true, timeFor: () => timestamp, color: (text) => text });
  try {
    const rendered = component.render(50);
    assert.deepEqual(rendered.slice(0, -1), native);
    assert.equal(tui.stripTerminalSequences(rendered.at(-1)).trim(), formatInteractionTime(timestamp));
  } finally { adapter.uninstall(); }
});

test('renderer adds only explicitly selected completed timestamps; streaming and partial results stay native', () => {
  const timestamp = Date.now();
  const message = { role: 'assistant', timestamp, content: [{ type: 'text', text: 'Native response' }], stopReason: 'stop' };
  const assistant = new sdk.AssistantMessageComponent(message);
  const selected = tool('selected');
  const other = tool('other');
  const assistantBody = assistant.render(50);
  const toolBody = selected.render(50);
  const otherBody = other.render(50);
  const original = sdk.ToolExecutionComponent.prototype.render;
  let enabled = true;
  const times = new Map([['assistant:' + timestamp, timestamp], ['tool:selected', timestamp]]);
  const adapter = installInteractionTimestampRenderers({ enabled: () => enabled, timeFor: (key) => times.get(key), color: (text) => text });
  try {
    assert.deepEqual(assistant.render(50).slice(0, -1), assistantBody);
    assert.equal(selected.render(50).length, toolBody.length);
    assert.deepEqual(selected.render(50).slice(0, -1), toolBody.slice(0, -1));
    assert.ok(selected.render(50).at(-1).includes('\x1b[48;'));
    assert.deepEqual(other.render(50), otherBody);
    assistant.updateContent(message, true);
    assert.deepEqual(assistant.render(50), assistantBody);
    selected.updateResult({ content: [{ type: 'text', text: 'Native tool output' }] }, true);
    enabled = false;
    const partialBody = selected.render(50);
    enabled = true;
    assert.deepEqual(selected.render(50), partialBody);
    enabled = false;
    assistant.updateContent(message, false);
    assert.deepEqual(assistant.render(50), assistantBody);
  } finally { adapter.uninstall(); }
  assert.equal(sdk.ToolExecutionComponent.prototype.render, original);
});

test('real native shell Took survives timestamp rendering, invalidation, and disabling the clock', () => {
  const native = nativeShell('native-live');
  const originalNow = Date.now;
  let enabled = true;
  const timings = new Map();
  const adapter = installInteractionTimestampRenderers({
    enabled: () => enabled, timeFor: () => 1400, color: (text) => text,
    shellTimingFor: (id) => timings.get(id), rememberShellTiming: (id, timing) => timings.set(id, timing),
  });
  try {
    Date.now = () => 1000;
    native.markExecutionStarted();
    Date.now = () => 1400;
    native.updateResult({ content: [{ type: 'text', text: 'ok' }], structuredContent: { wall_time_seconds: 0.3 }, timestamp: 1400 });
    // Native UI duration (0.4s) takes precedence over process wall time (0.3s).
    assert.match(renderedText(native), /Took 0\.4s/);
    assert.deepEqual(timings.get('native-live'), { ms: 400, endedAt: 1400 });
    native.invalidate();
    assert.match(renderedText(native), /Took 0\.4s/);
    enabled = false;
    assert.match(renderedText(native), /Took 0\.4s/);
    assert.equal(native.executionStarted, true);
  } finally { Date.now = originalNow; adapter.uninstall(); }
});

test('rebuilt bash and powershell frames recover Took from genuine saved wall time, without starting execution', () => {
  const adapter = installInteractionTimestampRenderers({ enabled: () => true, timeFor: () => 1400, color: (text) => text });
  try {
    for (const name of ['bash', 'powershell']) {
      const rebuilt = nativeShell('rebuilt-' + name, name);
      rebuilt.updateResult({ content: [{ type: 'text', text: 'ok' }], structuredContent: { wall_time_seconds: 0.4 }, timestamp: 1400 });
      assert.match(renderedText(rebuilt), /Took 0\.4s/);
      assert.equal(rebuilt.executionStarted, false, 'restoring rendering data is not an execution-start event');
      const noData = nativeShell('no-data-' + name, name);
      noData.updateResult({ content: [{ type: 'text', text: 'ok' }] });
      assert.doesNotMatch(renderedText(noData), /Took/, 'never invent an unknown duration');
    }
  } finally { adapter.uninstall(); }
});

test('timing restoration chains another plugin’s updateResult wrapper and restores it when unloaded', () => {
  const prototype = sdk.ToolExecutionComponent.prototype;
  const nativeUpdate = prototype.updateResult;
  let calls = 0;
  const otherPlugin = function (...args) { calls++; return nativeUpdate.apply(this, args); };
  prototype.updateResult = otherPlugin;
  const adapter = installInteractionTimestampRenderers({ enabled: () => false, timeFor: () => undefined, color: (text) => text });
  try {
    const component = nativeShell('other-plugin');
    component.updateResult({ content: [{ type: 'text', text: 'ok' }], structuredContent: { wall_time_seconds: 0.2 }, timestamp: 3000 });
    assert.equal(calls, 1);
    assert.match(renderedText(component), /Took 0\.2s/);
    adapter.uninstall();
    assert.equal(prototype.updateResult, otherPlugin);
  } finally {
    adapter.uninstall();
    if (prototype.updateResult === otherPlugin) prototype.updateResult = nativeUpdate;
  }
});

test('native shell timing persists in private metadata and is replayed after reload', async () => {
  const h = await setup();
  try {
    const message = { role: 'assistant', timestamp: 1000, stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'saved-shell', name: 'bash', arguments: { command: 'echo ok' } }] };
    const result = { role: 'toolResult', toolCallId: 'saved-shell', toolName: 'bash', timestamp: 1400,
      content: [{ type: 'text', text: 'ok' }], structuredContent: { wall_time_seconds: 0.4 } };
    h.manager.appendMessage(message);
    h.manager.appendMessage(result);
    const before = h.manager.buildSessionProjection().messages;
    const component = nativeShell('saved-shell');
    component.updateResult(result);
    assert.match(renderedText(component), /Took 0\.4s/);
    await h.finish(message, [result]);
    assert.deepEqual(h.records[0].data.shellTimings, [{ id: 'saved-shell', ms: 400, endedAt: 1400 }]);
    assert.deepEqual(h.manager.buildSessionProjection().messages, before);
    await h.close();
    await h.ext.handlers.get('session_start')[0]({ reason: 'reload' }, h.ctx);
    const restored = nativeShell('saved-shell');
    // Saved private UI timing also covers results without a wall_time field.
    restored.updateResult({ content: [{ type: 'text', text: 'ok' }], timestamp: 1400 });
    assert.match(renderedText(restored), /Took 0\.4s/);
    assert.equal(restored.executionStarted, false);
    const lines = restored.render(70).map(tui.stripTerminalSequences);
    const tookIndex = lines.findIndex((line) => line.includes('Took 0.4s'));
    assert.ok(tookIndex >= 0 && tookIndex < lines.length - 1);
    assert.match(lines.at(-1).trim(), /\d{2}:\d{2}:\d{2}$/);
  } finally { await h.close(); }
});

test('user messages, summaries and hidden controls are not separate model rounds', () => {
  const mode = Object.create(sdk.InteractiveMode.prototype);
  mode.chatContainer = new tui.Container(); mode.outputPad = 1; mode.ui = ui();
  mode.getUserMessageText = (msg) => msg.content[0].text;
  mode.getMarkdownThemeWithSettings = () => sdk.getMarkdownTheme(); mode.getMarkdownTransformers = () => [];
  const body = new sdk.UserMessageComponent('Native user message').render(50);
  const adapter = installInteractionTimestampRenderers({ enabled: () => true, timeFor: () => Date.now(), color: (text) => text });
  try {
    mode.addMessageToChat({ role: 'user', timestamp: Date.now(), content: [{ type: 'text', text: 'Native user message' }] });
    assert.deepEqual(mode.chatContainer.children.at(-1).render(50), body);
    const before = mode.chatContainer.children.length;
    mode.addMessageToChat({ role: 'custom', display: false, customType: 'hidden', content: [], timestamp: Date.now() });
    assert.equal(mode.chatContainer.children.length, before);
  } finally { adapter.uninstall(); }
});

test('a live round has no timestamp until turn_end, then records one journal-only timestamp and replays it', async () => {
  const h = await setup();
  try {
    const message = { role: 'assistant', timestamp: Date.now() - 600000, stopReason: 'stop', content: [{ type: 'text', text: 'Finished reply' }] };
    h.manager.appendMessage({ role: 'user', timestamp: Date.now() - 601000, content: [{ type: 'text', text: 'Task' }] });
    h.manager.appendMessage(message);
    const before = h.manager.buildSessionProjection().messages;
    const component = new sdk.AssistantMessageComponent(message);
    const native = component.render(50);
    assert.equal(h.records.length, 0);
    assert.equal(h.ext.handlers.has('message_end'), false);
    assert.equal(h.ext.handlers.has('tool_execution_end'), false);
    await h.finish(message);
    assert.equal(h.records.length, 1);
    assert.equal(h.records[0].data.version, 2);
    assert.equal(h.records[0].data.times.length, 1);
    const stamp = component.render(50).at(-1).trim();
    assert.equal(stamp, formatInteractionTime(h.records[0].data.times[0].at));
    assert.deepEqual(component.render(50).slice(0, -1), native);
    assert.deepEqual(h.manager.buildSessionProjection().messages, before);
    await h.close();
    await h.ext.handlers.get('session_start')[0]({ reason: 'reload' }, h.ctx);
    assert.equal(component.render(50).at(-1).trim(), stamp);
  } finally { await h.close(); }
});

test('parallel tools all finish before one timestamp appears on the last displayed block', async () => {
  const h = await setup();
  const originalNow = Date.now;
  try {
    const message = { role: 'assistant', timestamp: originalNow(), stopReason: 'toolUse', content: [
      { type: 'text', text: 'Calling tools' }, { type: 'toolCall', id: 'parallel-a', name: 'read', arguments: {} }, { type: 'toolCall', id: 'parallel-b', name: 'read', arguments: {} },
    ] };
    const assistant = new sdk.AssistantMessageComponent(message);
    const a = tool('parallel-a'), b = tool('parallel-b');
    const assistantBody = assistant.render(60), aBody = a.render(60), bBody = b.render(60);
    h.manager.appendMessage(message);
    // B finishes earlier but is the last tool in the rendered call order.
    const results = [
      { role: 'toolResult', toolCallId: 'parallel-b', content: [], timestamp: originalNow() },
      { role: 'toolResult', toolCallId: 'parallel-a', content: [], timestamp: originalNow() + 1000 },
    ];
    for (const result of results) h.manager.appendMessage(result);
    assert.deepEqual(a.render(60), aBody);
    assert.deepEqual(b.render(60), bBody);
    assert.equal(h.records.length, 0);
    const roundEnd = originalNow() + 2000;
    Date.now = () => roundEnd;
    await h.finish(message, results);
    assert.deepEqual(h.records[0].data.times, [{ key: 'tool:parallel-b', at: roundEnd }]);
    assert.deepEqual(assistant.render(60), assistantBody);
    assert.deepEqual(a.render(60), aBody);
    assert.equal(b.render(60).length, bBody.length);
    assert.equal(tui.stripTerminalSequences(b.render(60).at(-1)).trim(), formatInteractionTime(roundEnd));
  } finally { Date.now = originalNow; await h.close(); }
});

test('the real agent loop stamps a completed tool batch before issuing its next provider request', async () => {
  const h = await setup();
  const { Agent } = VIRTUAL_MODULES['@earendil-works/pi-agent-core'];
  const { AssistantMessageEventStream } = VIRTUAL_MODULES['@earendil-works/pi-ai'];
  let requests = 0;
  const model = { id: 'timestamp-test', name: 'Timestamp fixture', provider: 'fixture', api: 'openai-completions',
    reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const agent = new Agent({
    initialState: { model, tools: ['first', 'last'].map((name) => ({
      name, label: name, description: 'Fixture', parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'Done' }], details: {} }),
    })) },
    finishTurn: async ({ message, toolResults }) => { await h.finish(message, toolResults); },
    streamFn: (_model, context) => {
      requests++;
      if (requests === 2) {
        assert.equal(h.records.length, 1, 'one entire tool round must already be stamped');
        assert.equal(h.records[0].data.times[0].key, 'tool:loop-last');
        assert.equal(context.messages.some((item) => item.role === 'custom'), false);
      }
      const message = { role: 'assistant', provider: model.provider, model: model.id, api: model.api, timestamp: 1000 + requests,
        content: requests === 1 ? [{ type: 'toolCall', id: 'loop-first', name: 'first', arguments: {} },
          { type: 'toolCall', id: 'loop-last', name: 'last', arguments: {} }] : [{ type: 'text', text: 'Final reply' }],
        stopReason: requests === 1 ? 'toolUse' : 'stop',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = new AssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(); });
      return stream;
    },
  });
  try {
    await agent.prompt('Finish the task');
    assert.equal(requests, 2);
    assert.equal(h.records.length, 2, 'tool batch and final reply are two model turns');
    assert.equal(h.records[1].data.times[0].key, 'assistant:1002');
  } finally { await h.close(); }
});

test('legacy per-tool timestamps are grouped as one round when reopening the session', async () => {
  const manager = SessionManager.inMemory();
  const message = { role: 'assistant', timestamp: 1000, stopReason: 'toolUse', content: [
    { type: 'text', text: 'Old tool batch' }, { type: 'toolCall', id: 'old-a' }, { type: 'toolCall', id: 'old-b' },
  ] };
  manager.appendMessage(message);
  manager.appendMessage({ role: 'toolResult', toolCallId: 'old-a', timestamp: 5000, content: [] });
  manager.appendMessage({ role: 'toolResult', toolCallId: 'old-b', timestamp: 4000, content: [] });
  manager.appendCustomEntry('pi-workspace-manager:interaction-times', { times: [
    { key: 'assistant:1000', at: 2000 }, { key: 'tool:old-a', at: 6000 }, { key: 'tool:old-b', at: 5500 },
  ] });
  const before = manager.buildSessionProjection().messages;
  const h = await setup(manager);
  try {
    const a = tool('old-a'), b = tool('old-b');
    assert.equal(tui.stripTerminalSequences(a.render(60).at(-1)).trim(), '');
    assert.equal(tui.stripTerminalSequences(b.render(60).at(-1)).trim(), formatInteractionTime(6000));
    assert.deepEqual(manager.buildSessionProjection().messages, before);
    assert.equal(h.records.length, 0, 'replaying timestamps must not append new metadata');
  } finally { await h.close(); }
});

test('an empty assistant reply does not manufacture a timestamp-only conversation block', async () => {
  const h = await setup();
  try {
    const message = { role: 'assistant', timestamp: Date.now(), stopReason: 'stop', content: [] };
    await h.finish(message);
    assert.deepEqual(new sdk.AssistantMessageComponent(message).render(60), []);
  } finally { await h.close(); }
});

test('idle transcript refreshes at midnight so a completed round acquires its date', async (t) => {
  const h = await setup();
  const clock = new Date(2026, 9, 3, 23, 59).getTime();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: clock });
  let refreshes = 0;
  const mode = Object.create(sdk.InteractiveMode.prototype);
  mode.chatContainer = new tui.Container(); mode.outputPad = 1; mode.ui = { requestRender() { refreshes++; }, invalidate() {} };
  mode.hideThinkingBlock = false;
  mode.getMarkdownThemeWithSettings = () => sdk.getMarkdownTheme(); mode.getMarkdownTransformers = () => [];
  try {
    await h.close();
    await h.ext.handlers.get('session_start')[0]({ reason: 'reload' }, h.ctx);
    const message = { role: 'assistant', timestamp: clock, stopReason: 'stop', content: [{ type: 'text', text: 'Finished round' }] };
    mode.addMessageToChat(message);
    await h.finish(message);
    const component = mode.chatContainer.children.at(-1);
    assert.equal(component.render(60).at(-1).trim(), '23:59:00');
    t.mock.timers.tick(60010);
    assert.equal(component.render(60).at(-1).trim(), '2026-10-03 23:59:00');
    assert.ok(refreshes > 0);
  } finally { await h.close(); t.mock.timers.reset(); }
});

test('/wm-settings toggles round timestamps immediately without changing the model tool loadout', async () => {
  const previousProfile = process.env.USERPROFILE;
  const tempRoot = join(previousProfile || process.env.HOME, 'Temp');
  const tempRootExisted = existsSync(tempRoot);
  mkdirSync(tempRoot, { recursive: true });
  const testHome = mkdtempSync(join(tempRoot, 'wm-timestamp-test-'));
  let loaded;
  try {
    process.env.USERPROFILE = testHome;
    const agentDir = join(testHome, '.pi', 'agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ marker: 'keep', 'pi-workspace-manager': { timestamps: { enabled: true } } }));
    loaded = await discoverAndLoadExtensions([join(pluginDir, 'index.ts')], pluginDir, pluginDir);
    assert.deepEqual(loaded.errors, []);
    loaded.runtime.getActiveTools = () => [];
    let toolChanges = 0;
    loaded.runtime.setActiveTools = () => { toolChanges++; };
    loaded.runtime.appendEntry = () => {};
    const ext = loaded.extensions[0];
    const message = { role: 'assistant', timestamp: Date.now(), stopReason: 'stop', content: [{ type: 'text', text: 'Immediate toggle' }] };
    const component = new sdk.AssistantMessageComponent(message);
    const native = component.render(60);
    const ctx = { mode: 'tui', sessionManager: SessionManager.inMemory(), ui: ui() };
    await ext.handlers.get('session_start')[0]({ reason: 'startup' }, ctx);
    await ext.handlers.get('turn_end')[0]({ message, toolResults: [] }, ctx);
    const command = ext.commands.get('wm-settings');
    const toggle = async () => command.handler('', { mode: 'tui', cwd: pluginDir, ui: {
      notify() {}, custom: async (factory) => new Promise((resolve) => {
        const view = factory({ requestRender() {} }, { fg: (_name, value) => value, bold: (value) => value }, {}, resolve);
        for (const char of '时间戳') view.handleInput(char);
        view.handleInput('\r'); view.handleInput('\x1b');
      }),
    } });
    await toggle();
    let saved = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'));
    assert.equal(saved['pi-workspace-manager'].timestamps.enabled, false);
    assert.equal(saved.marker, 'keep');
    assert.deepEqual(component.render(60), native);
    await toggle();
    saved = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'));
    assert.equal(saved['pi-workspace-manager'].timestamps.enabled, true);
    assert.match(component.render(60).at(-1), /\d{2}:\d{2}:\d{2} $/);
    assert.equal(toolChanges, 0);
  } finally {
    if (loaded) await loaded.extensions[0].handlers.get('session_shutdown')[0]({}, {});
    if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
    rmSync(testHome, { recursive: true, force: true });
    if (!tempRootExisted) rmSync(tempRoot, { recursive: true, force: true });
  }
});
