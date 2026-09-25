import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const pluginDir = join(import.meta.dirname, '..');
const chunksDir = join(process.env.APPDATA, 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'chunks');
const chunk = readdirSync(chunksDir).find((name) => name.endsWith('.js') &&
  readFileSync(join(chunksDir, name), 'utf8').includes('async _runAgentPrompt(messages){'));
assert.ok(chunk, 'Pi CLI core chunk not found');
const { discoverAndLoadExtensions, AgentSession, SessionManager, ExtensionRunner, CustomEditor } =
  await import(pathToFileURL(join(chunksDir, chunk)).href);
const result = await discoverAndLoadExtensions([join(pluginDir, 'index.ts')], pluginDir, pluginDir);
assert.deepEqual(result.errors, []);
const extension = result.extensions[0];
assert.ok(extension, 'extension did not load in Pi CLI bundle');
const markerType = 'pi-workspace-manager:empty-enter-recovery';
const marker = { role: 'custom', customType: markerType, content: [], display: false };
const messageEntry = (role, stopReason) => ({ type: 'message', message: { role, stopReason } });
const recoveryHook = extension.handlers.get('context').at(-1);

async function modelContext(messages) {
  const runner = new ExtensionRunner([extension], {}, process.cwd(), SessionManager.inMemory(), {});
  return runner.emitContext(messages);
}

function editorHarness(initialBranch) {
  let branch = initialBranch;
  let idle = true;
  let pending = false;
  let factory;
  const sent = [];
  result.runtime.sendMessage = (...args) => { sent.push(args); };
  const ctx = {
    mode: 'tui',
    ui: {
      getEditorComponent: () => undefined,
      setEditorComponent: (value) => { factory = value; },
      notify: (message) => { throw new Error(message); },
    },
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    sessionManager: { getBranch: () => branch },
  };
  return {
    async setup() {
      await extension.handlers.get('session_start')[0]({ type: 'session_start', reason: 'startup' }, ctx);
      assert.equal(typeof factory, 'function');
      const editor = factory({ requestRender() {} }, { borderColor: (text) => text },
        { matches: (data, action) => data === '\r' && action === 'tui.input.submit' });
      return editor;
    },
    sent,
    setBranch: (value) => { branch = value; },
    setIdle: (value) => { idle = value; },
    setPending: (value) => { pending = value; },
  };
}

test('stock Pi loads both context hooks without errors or extra commands', () => {
  assert.equal(typeof AgentSession.prototype.resumeInterrupted, 'undefined');
  assert.equal(extension.handlers.get('context').length, 2);
  assert.equal([...extension.commands.keys()].some((name) => name.includes('recovery')), false);
});

for (const stopReason of ['error', 'aborted', 'length', 'toolUse']) {
  test(`empty Enter resumes ${stopReason} with exactly one empty hidden marker`, async () => {
    const harness = editorHarness([messageEntry('user'), messageEntry('assistant', stopReason)]);
    const editor = await harness.setup();
    editor.setText('');
    editor.handleInput('\r');
    assert.deepEqual(harness.sent, [[{ customType: markerType, content: [], display: false }, { triggerTurn: true }]]);
    assert.equal(editor.getText(), '');
  });
}

test('typed input and normal completion keep the standard editor submit behavior', async () => {
  const harness = editorHarness([messageEntry('user'), messageEntry('assistant', 'stop')]);
  const editor = await harness.setup();
  const submits = [];
  editor.onSubmit = (value) => submits.push(value);
  editor.setText('Normal input');
  editor.handleInput('\r');
  editor.handleInput('\r');
  assert.deepEqual(submits, ['Normal input', '']);
  assert.deepEqual(harness.sent, []);
});

test('running or queued agent and autocomplete never resume', async () => {
  const harness = editorHarness([messageEntry('user'), messageEntry('assistant', 'aborted')]);
  const editor = await harness.setup();
  editor.setText('');
  harness.setIdle(false);
  editor.handleInput('\r');
  harness.setIdle(true);
  harness.setPending(true);
  editor.handleInput('\r');
  harness.setPending(false);
  editor.isShowingAutocomplete = () => true;
  editor.handleInput('\r');
  assert.deepEqual(harness.sent, []);
});

test('new session and normal completion after an abort do not resume', async () => {
  const harness = editorHarness([]);
  const editor = await harness.setup();
  editor.handleInput('\r');
  harness.setBranch([messageEntry('user'), messageEntry('assistant', 'aborted'), messageEntry('assistant', 'stop')]);
  editor.handleInput('\r');
  assert.deepEqual(harness.sent, []);
});

test('interrupted before response and unfinished tool turn can resume', async () => {
  const harness = editorHarness([messageEntry('user')]);
  const editor = await harness.setup();
  editor.handleInput('\r');
  harness.setBranch([messageEntry('user'), messageEntry('assistant', 'toolUse'), messageEntry('toolResult')]);
  editor.handleInput('\r');
  assert.equal(harness.sent.length, 2);
});

for (const stopReason of ['error', 'aborted', 'length', 'toolUse']) {
  test(`actual Pi context hook removes ${stopReason} and all hidden markers`, async () => {
    const user = { role: 'user', content: [{ type: 'text', text: 'Existing task' }] };
    const failed = { role: 'assistant', stopReason, content: [] };
    assert.deepEqual((await recoveryHook({ messages: [user, failed, marker, marker] }, {})).messages, [user]);
    const system = { role: 'system', content: 'Existing system prompt', timestamp: 0 };
    assert.deepEqual(await modelContext([system, user, failed, marker]), [system, user]);
  });
}

test('a normal request is unchanged; old markers never reach future requests', async () => {
  const user = { role: 'user', content: [] };
  const normal = { role: 'assistant', stopReason: 'stop', content: [] };
  assert.equal(await recoveryHook({ messages: [user, normal] }, {}), undefined);
  assert.deepEqual(await modelContext([user, marker, normal, marker]), [user, normal]);
});

test('stock AgentSession accepts the empty marker as an ordinary session turn', async () => {
  const session = Object.create(AgentSession.prototype);
  session._isAgentRunActive = false;
  session._isEmittingAgentSettled = false;
  let prompted;
  session._runAgentPrompt = async (value) => { prompted = value; };
  await session.sendCustomMessage({ customType: markerType, content: [], display: false }, { triggerTurn: true });
  assert.deepEqual({ role: prompted.role, type: prompted.customType, content: prompted.content, display: prompted.display },
    { role: 'custom', type: markerType, content: [], display: false });
});

test('the hidden entry persists only in the session journal, not model context', async () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Existing task' }], timestamp: 1 });
  manager.appendMessage({ role: 'assistant', content: [], stopReason: 'aborted', timestamp: 2 });
  manager.appendCustomMessageEntry(markerType, [], false);
  assert.equal(manager.getBranch().at(-1).type, 'custom_message');
  const filtered = await modelContext(manager.buildSessionProjection().messages);
  assert.deepEqual(filtered.filter((item) => item.role !== 'system').map((item) => item.role), ['user']);
});

test('wrapped editor preserves Pi’s native working indicator in its top border', () => {
  const editor = new CustomEditor({ requestRender() {} }, { borderColor: (text) => text }, {}, { embedWorkingStatus: true });
  editor.setWorkingStatusIndicator({ renderInBorder: () => 'Working...', renderSpinnerInBorder: () => 'Working' });
  assert.equal(editor.embedWorkingStatus, true);
  assert.match(editor.renderTopBorder(80, 0), /Working\.\.\./);
});
