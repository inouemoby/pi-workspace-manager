import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const pluginDir = join(import.meta.dirname, '..');
const chunksDir = join(process.env.APPDATA, 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'chunks');
const chunk = readdirSync(chunksDir).find((name) => name.endsWith('.js') &&
  readFileSync(join(chunksDir, name), 'utf8').includes('async _runAgentPrompt(messages){'));
assert.ok(chunk, 'Installed Pi bundle is not available');
const { discoverAndLoadExtensions, AgentSession } = await import(pathToFileURL(join(chunksDir, chunk)).href);

async function setup() {
  const loaded = await discoverAndLoadExtensions([join(pluginDir, 'index.ts')], pluginDir, pluginDir);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  let factory;
  let busy = false;
  let hasPending = false;
  let compaction;
  const sends = [];
  const submissions = [];
  const ctx = {
    mode: 'tui', hasUI: true, cwd: pluginDir,
    ui: {
      getEditorComponent: () => undefined,
      setEditorComponent: (f) => { factory = f; },
      notify: () => {},
    },
    sessionManager: { getSessionId: () => 'test-session', getBranch: () => [] },
    isIdle: () => !busy,
    hasPendingMessages: () => hasPending,
    getContextUsage: () => ({ tokens: 500, contextWindow: 600, percent: 99.5 }),
    compact: (options) => { compaction = options; },
  };
  loaded.runtime.sendMessage = (...args) => { sends.push(args); busy = true; };
  loaded.runtime.sendUserMessage = () => { throw new Error('sendUserMessage has an async prompt preflight and may race'); };
  await extension.handlers.get('session_start')[0]({ type: 'session_start', reason: 'startup' }, ctx);
  const editor = factory({ requestRender() {} }, { borderColor: (text) => text },
    { matches: (data, action) => (data === '\r' && action === 'tui.input.submit') ||
      (data === 'FOLLOW_UP' && action === 'app.message.followUp') });
  editor.onSubmit = (text) => submissions.push(text);
  const execute = () => extension.tools.get('pi_compact').definition.execute('compact',
    { unfinishedTask: 'Complete the original task' }, undefined, undefined, ctx);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  return {
    extension, editor, execute, sends, submissions, settle,
    get compaction() { return compaction; },
    setBusy: (value) => { busy = value; },
    setPending: (value) => { hasPending = value; },
    shutdown: () => extension.handlers.get('session_shutdown')[0]({ type: 'session_shutdown' }, ctx),
  };
}

test('Pi sendCustomMessage marks the agent busy before another prompt can start', async () => {
  const session = Object.create(AgentSession.prototype);
  let finishPrompt;
  const queued = [];
  session.agent = {
    prompt: () => new Promise((resolve) => { finishPrompt = resolve; }),
    followUp: (message) => queued.push(message),
  };
  session._recordSelection = () => {};
  session._pendingToolNames = new Set();
  session._handlePostAgentRun = async () => false;
  session._runBeforeSettleBoundary = async () => false;
  session._flushPendingBashMessages = () => {};
  session._flushPendingCustomMessages = () => {};
  session._emitAgentSettled = async () => { session._isAgentRunActive = false; };
  const first = session.sendCustomMessage({ customType: 'test-resume', content: 'Continue', display: false },
    { triggerTurn: true, deliverAs: 'followUp' });
  assert.equal(session.isStreaming, true);
  await session.sendCustomMessage({ customType: 'later-input', content: 'New input', display: false },
    { triggerTurn: true, deliverAs: 'followUp' });
  assert.equal(queued.length, 1);
  finishPrompt();
  await first;
});

test('installed Pi starts exactly one safe turn after untouched manual compaction', async () => {
  const h = await setup();
  const first = await h.execute();
  assert.equal(first.details.status, 'started');
  assert.equal(first.terminate, true);
  assert.equal((await h.execute()).details.status, 'already-in-progress');
  h.compaction.onComplete({ summary: 'Existing context' });
  h.compaction.onComplete({ summary: 'Duplicate callback' });
  await h.settle();
  assert.deepEqual(h.sends, [[{
    customType: 'pi-workspace-manager:compaction-resume',
    content: '继续任务：Complete the original task', display: false,
  }, { triggerTurn: true, deliverAs: 'followUp' }]]);
  assert.equal((await h.execute()).details.status, 'started');
  await h.shutdown();
});

test('a user message typed during compaction takes precedence over auto-resume', async () => {
  const h = await setup();
  await h.execute();
  h.editor.setText('Please handle the new request');
  h.editor.handleInput('\r');
  assert.deepEqual(h.submissions, ['Please handle the new request']);
  h.compaction.onComplete({ summary: 'Compacted' });
  await h.settle();
  assert.deepEqual(h.sends, []);
  await h.shutdown();
});

test('Alt+Enter follow-up during compaction also takes precedence', async () => {
  const h = await setup();
  await h.execute();
  h.editor.onAction('app.message.followUp', () => h.submissions.push('queued follow-up'));
  h.editor.setText('Follow-up after compaction');
  h.editor.handleInput('FOLLOW_UP');
  h.compaction.onComplete({ summary: 'Compacted' });
  await h.settle();
  assert.deepEqual(h.submissions, ['queued follow-up']);
  assert.deepEqual(h.sends, []);
  await h.shutdown();
});

test('Pi post-compaction input event suppresses auto-resume even if the editor was bypassed', async () => {
  const h = await setup();
  await h.execute();
  h.compaction.onComplete({ summary: 'Compacted' });
  await h.extension.handlers.get('input')[0]({ source: 'interactive', text: 'queued input' }, {});
  await h.settle();
  assert.deepEqual(h.sends, []);
  await h.shutdown();
});

test('another active run or queue prevents competing agent prompts', async () => {
  for (const scenario of ['busy', 'pending']) {
    const h = await setup();
    await h.execute();
    if (scenario === 'busy') h.setBusy(true);
    else h.setPending(true);
    h.compaction.onComplete({ summary: 'Compacted' });
    await h.settle();
    assert.deepEqual(h.sends, [], scenario);
    await h.shutdown();
  }
});

test('submitting a message cancels a scheduled compaction retry immediately', async () => {
  const h = await setup();
  await h.execute();
  h.compaction.onError(new Error('Transient summarization failure'));
  assert.equal((await h.execute()).details.status, 'already-in-progress');
  h.editor.setText('Handle my new message');
  h.editor.handleInput('\r');
  assert.deepEqual(h.submissions, ['Handle my new message']);
  assert.equal((await h.execute()).details.status, 'started');
  assert.deepEqual(h.sends, []);
  await h.shutdown();
});

test('an already-compacted race resumes only when Pi is truly idle', async () => {
  const idle = await setup();
  await idle.execute();
  idle.compaction.onError(new Error('Already compacted'));
  await idle.settle();
  assert.equal(idle.sends.length, 1);
  await idle.shutdown();

  const busy = await setup();
  await busy.execute();
  busy.setBusy(true);
  busy.compaction.onError(new Error('Already compacted'));
  await busy.settle();
  assert.deepEqual(busy.sends, []);
  await busy.shutdown();
});

test('cancelled compaction never resumes or schedules a retry', async () => {
  const h = await setup();
  await h.execute();
  h.compaction.onError(new Error('Compaction cancelled'));
  await h.settle();
  assert.deepEqual(h.sends, []);
  await h.shutdown();
});

test('shutdown cancels pending continuation before it can start another session', async () => {
  const h = await setup();
  await h.execute();
  h.compaction.onComplete({ summary: 'Compacted' });
  await h.shutdown();
  await h.settle();
  assert.deepEqual(h.sends, []);
});
