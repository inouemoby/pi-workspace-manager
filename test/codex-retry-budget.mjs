import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const pluginDir = join(import.meta.dirname, '..');
const chunksDir = join(process.env.APPDATA, 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'chunks');
const chunk = readdirSync(chunksDir).find((name) => name.endsWith('.js') && readFileSync(join(chunksDir, name), 'utf8').includes('async _runAgentPrompt(messages){'));
const { AgentSession, SettingsManager, SessionManager, discoverAndLoadExtensions } = await import(pathToFileURL(join(chunksDir, chunk)).href);
const files = readdirSync(chunksDir);
const { createJiti } = await import(pathToFileURL(join(chunksDir, files.find((n) => /^jiti-static-loader.*\.js$/.test(n)))).href);
const { VIRTUAL_MODULES } = await import(pathToFileURL(join(chunksDir, files.find((n) => /^virtual-modules.*\.js$/.test(n)))).href);
const { installNativeCodexRetryPolicy } = await createJiti(import.meta.url, { moduleCache: false, tryNative: false, virtualModules: VIRTUAL_MODULES }).import(join(pluginDir, 'index.ts'));
const genericError = 'Codex error: An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists.';

async function setup({ wmEnabled = true, wmMax = 10, nativeEnabled = true, nativeMax = 3, provider = 'openai-codex', baseDelayMs = 0, image = false } = {}) {
  const previousProfile = process.env.USERPROFILE;
  const tempRoot = join(previousProfile || process.env.HOME, 'Temp');
  const existed = existsSync(tempRoot);
  mkdirSync(tempRoot, { recursive: true });
  const home = mkdtempSync(join(tempRoot, 'wm-retry-test-'));
  let loaded;
  try {
    process.env.USERPROFILE = home;
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({
      'pi-workspace-manager': { codexRetry: { enabled: wmEnabled, maxRetries: wmMax } },
    }));
    loaded = await discoverAndLoadExtensions([join(pluginDir, 'index.ts')], pluginDir, pluginDir);
    assert.deepEqual(loaded.errors, []);
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    if (!existed) rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  } finally {
    if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
  }
  const ext = loaded.extensions[0];
  loaded.runtime.sendMessage = () => { throw new Error('Retries must not inject a custom prompt'); };
  loaded.runtime.sendUserMessage = () => { throw new Error('Retries must not inject a user prompt'); };
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: 'user', timestamp: 1, content: [{ type: 'text', text: 'Original task' },
    ...(image ? [{ type: 'image', data: 'test-data', mimeType: 'image/png' }] : [])] });
  const settings = SettingsManager.inMemory({ retry: { enabled: nativeEnabled, maxRetries: nativeMax, baseDelayMs, maxAgentDelayMs: baseDelayMs, provider: { maxRetries: 0 } }, compaction: { enabled: false } });
  const model = { provider, id: 'fixture', contextWindow: 100000 };
  const session = Object.create(AgentSession.prototype);
  session.sessionManager = manager;
  session.settingsManager = settings;
  session.agent = { state: { model, messages: manager.buildSessionProjection().messages }, hasQueuedMessages: () => false };
  session._entryIdsByMessage = new WeakMap();
  session._retryAttempt = 0;
  session._agentRunAbortRequested = false;
  session._modelForMessage = () => model;
  session._checkCompaction = async () => false;
  const notifications = [];
  const events = [];
  let onEvent;
  session._emit = (event) => { events.push(event); onEvent?.(event); };
  const ctx = { mode: 'json', hasUI: true, model, sessionManager: manager, ui: { notify: (...args) => notifications.push(args) } };
  session._extensionRunner = {
    emit: async (event) => {
      for (const handler of ext.handlers.get(event.type) ?? []) await handler(event, ctx);
    },
  };
  let errors = 0;
  const failure = async (text = genericError) => {
    const message = { role: 'assistant', provider, model: model.id, api: 'openai-codex-responses', timestamp: 10 + errors++,
      content: [], stopReason: 'error', errorMessage: text, usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
    manager.appendMessage(message);
    session.agent.state.messages = manager.buildSessionProjection().messages;
    await session._emitExtensionEvent({ type: 'agent_end', messages: [message] });
    return message;
  };
  return {
    session, manager, settings, model, ext, ctx, events, notifications, failure,
    onEvent: (handler) => { onEvent = handler; },
    close: async () => {
      await ext.handlers.get('session_shutdown')[0]({}, ctx);
      rmSync(home, { recursive: true, force: true });
      if (!existed) rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

test('WM 10 produces ten actual native retries and a final failure after 10, not 3', async () => {
  const h = await setup();
  try {
    const originalGetter = h.settings.getRetrySettings;
    for (let attempt = 0; attempt <= 10; attempt++) {
      const message = await h.failure();
      assert.equal(h.session.retryAttempt, attempt);
      assert.equal(h.session._willRetryAfterAgentEnd({ messages: [message] }), attempt < 10);
      assert.equal(await h.session._prepareRetry(message), attempt < 10);
      assert.equal(h.settings.getRetrySettings, originalGetter, 'temporary native policy must restore the original getter');
      assert.equal(h.settings.getRetrySettings().maxRetries, 3, 'no global settings mutation');
      assert.equal(Object.getOwnPropertySymbols(h.settings).some((key) => String(key).includes('native-retry-settings-root')), false);
    }
    const starts = h.events.filter((event) => event.type === 'auto_retry_start');
    assert.equal(starts.length, 10);
    assert.deepEqual(starts.map((event) => event.attempt), Array.from({ length: 10 }, (_, i) => i + 1));
    assert.ok(starts.every((event) => event.maxAttempts === 10));
    h.session._lastAssistantMessage = h.manager.buildSessionProjection().messages.at(-1);
    h.session._lastAssistantToolResults = [];
    assert.equal(await h.session._handlePostAgentRun(), false);
    const final = h.events.findLast((event) => event.type === 'auto_retry_end');
    assert.equal(final.attempt, 10);
    assert.equal(final.success, false);
    assert.equal(h.manager.getBranch().filter((entry) => entry.type === 'message' && entry.message.role === 'user').length, 1);
    assert.equal(h.manager.getBranch().some((entry) => entry.type === 'custom_message'), false);
    assert.equal(h.notifications.some(([text]) => /scheduling system retry/.test(text)), false);
    assert.equal(h.settings.getProviderRetrySettings().maxRetries, 0);
  } finally { await h.close(); }
});

test('Pi’s original session loop actually issues the initial request plus ten retry requests', async () => {
  const h = await setup();
  let requests = 0;
  try {
    h.session._recordSelection = () => {};
    h.session._pendingToolNames = new Set();
    h.session._deferredSettledActions = [];
    h.session._flushPendingBashMessages = () => {};
    h.session._flushPendingCustomMessages = () => {};
    h.session._runBeforeSettleBoundary = async () => false;
    const request = async () => {
      requests++;
      const message = await h.failure();
      h.session._lastAssistantMessage = message;
      h.session._lastAssistantToolResults = [];
    };
    h.session.agent.prompt = request;
    h.session.agent.continue = request;
    // These are the installed Pi _runAgentPrompt, _handlePostAgentRun,
    // _prepareRetry, recovery omission and settlement methods—not a plugin loop.
    await h.session._runAgentPrompt({ role: 'user', content: [] });
    assert.equal(requests, 11);
    assert.equal(h.events.filter((event) => event.type === 'auto_retry_start').length, 10);
    assert.equal(h.events.findLast((event) => event.type === 'auto_retry_end').attempt, 10);
    assert.equal(h.session.isStreaming, false);
    assert.equal(h.session.retryAttempt, 0);
  } finally { await h.close(); }
});

test('zero budget and native disabled retry never report or schedule extra attempts', async () => {
  for (const options of [{ wmMax: 0 }, { nativeEnabled: false }]) {
    const h = await setup(options);
    try {
      const message = await h.failure();
      assert.equal(h.session._willRetryAfterAgentEnd({ messages: [message] }), false);
      assert.equal(await h.session._prepareRetry(message), false);
      assert.equal(h.events.some((event) => event.type === 'auto_retry_start'), false);
      assert.equal(message.errorMessage, genericError);
    } finally { await h.close(); }
  }
});

test('other providers and disabling WM keep the ordinary native budget of 3', async () => {
  for (const options of [{ provider: 'anthropic' }, { wmEnabled: false }]) {
    const h = await setup(options);
    try {
      for (let attempt = 0; attempt <= 3; attempt++) {
        const message = await h.failure('Server error fixture');
        assert.equal(await h.session._prepareRetry(message), attempt < 3);
      }
      const starts = h.events.filter((event) => event.type === 'auto_retry_start');
      assert.equal(starts.length, 3);
      assert.ok(starts.every((event) => event.maxAttempts === 3));
    } finally { await h.close(); }
  }
});

test('native cancellation remains abortable, resets its counter and restores settings during backoff', async () => {
  const h = await setup({ baseDelayMs: 1000 });
  try {
    const message = await h.failure();
    h.onEvent((event) => {
      if (event.type === 'auto_retry_start') queueMicrotask(() => h.session.abortRetry());
    });
    const retry = h.session._prepareRetry(message);
    assert.equal(h.events.findLast((event) => event.type === 'auto_retry_start').delayMs, 1000);
    assert.equal(h.settings.getRetrySettings().maxRetries, 3, 'budget override must not remain installed during sleep');
    assert.equal(await retry, false);
    assert.equal(h.session.retryAttempt, 0);
    assert.equal(h.events.findLast((event) => event.type === 'auto_retry_end').finalError, 'Retry cancelled');
  } finally { await h.close(); }
});

test('duplicate agent_end notifications do not add markers or consume an extension counter', async () => {
  const h = await setup();
  try {
    const message = await h.failure();
    for (let i = 0; i < 12; i++) await h.session._emitExtensionEvent({ type: 'agent_end', messages: [message] });
    assert.equal(message.errorMessage.split('[pi-workspace-manager: retryable Codex server error]').length - 1, 1);
    assert.equal(h.session.retryAttempt, 0);
    assert.equal(await h.session._prepareRetry(message), true);
    assert.equal(h.events.findLast((event) => event.type === 'auto_retry_start').attempt, 1);
    assert.deepEqual(h.notifications, []);
  } finally { await h.close(); }
});

test('successful response and a fresh run read Pi’s reset counter, not an accumulated WM counter', async () => {
  const h = await setup();
  try {
    const first = await h.failure();
    assert.equal(await h.session._prepareRetry(first), true);
    assert.equal(h.session.retryAttempt, 1);
    // Pi resets this counter at successful message_end. WM must observe it
    // rather than maintain an independent lifetime counter across runs.
    h.session._retryAttempt = 0;
    await h.session._emitExtensionEvent({ type: 'agent_end', messages: [{ role: 'assistant', provider: 'openai-codex', stopReason: 'stop', content: [] }] });
    await h.ext.handlers.get('agent_settled')[0]({}, h.ctx);
    const next = await h.failure();
    assert.equal(await h.session._prepareRetry(next), true);
    assert.deepEqual(h.events.filter((event) => event.type === 'auto_retry_start').map((event) => event.attempt), [1, 1]);
  } finally { await h.close(); }
});

test('image fallback does not reset or extend the native total retry budget', async () => {
  const h = await setup({ image: true, wmMax: 4 });
  try {
    for (let i = 0; i < 3; i++) {
      const message = await h.failure('Bad request: inline image failure');
      assert.equal(await h.session._prepareRetry(message), true);
    }
    const imageContext = { messages: h.manager.buildSessionProjection().messages };
    const stripped = await h.ext.handlers.get('context')[0](imageContext, h.ctx);
    assert.ok(stripped?.messages);
    assert.equal(h.session.retryAttempt, 3);
    const fourth = await h.failure();
    assert.equal(await h.session._prepareRetry(fourth), true);
    const last = await h.failure();
    assert.equal(await h.session._prepareRetry(last), false);
    assert.equal(h.events.filter((event) => event.type === 'auto_retry_start').length, 4);
  } finally { await h.close(); }
});

test('two loaded policy adapters still isolate a shared manager and restore its getter', async () => {
  const h = await setup();
  const extra = installNativeCodexRetryPolicy(() => 10);
  try {
    const other = Object.create(AgentSession.prototype);
    other.settingsManager = h.settings;
    other.sessionManager = SessionManager.inMemory();
    other.agent = { state: { model: { provider: 'anthropic', contextWindow: 100000 } } };
    other._retryAttempt = 3;
    other._modelForMessage = () => other.model;
    const originalGetter = h.settings.getRetrySettings;
    h.onEvent((event) => {
      if (event.type === 'auto_retry_start') {
        assert.equal(other._willRetryAfterAgentEnd({ messages: [{ role: 'assistant', provider: 'anthropic', stopReason: 'error', errorMessage: 'Server error' }] }), false);
      }
    });
    const message = await h.failure();
    assert.equal(await h.session._prepareRetry(message), true);
    assert.equal(h.settings.getRetrySettings, originalGetter);
    assert.equal(h.settings.getRetrySettings().maxRetries, 3);
  } finally { extra.uninstall(); await h.close(); }
});

test('nested observers sharing a settings manager cannot leak Codex policy into another provider', async () => {
  const h = await setup();
  try {
    const other = Object.create(AgentSession.prototype);
    other.settingsManager = h.settings;
    other.sessionManager = SessionManager.inMemory();
    other.agent = { state: { model: { provider: 'anthropic', contextWindow: 100000 } } };
    other._retryAttempt = 3;
    other._modelForMessage = () => other.model;
    h.onEvent((event) => {
      if (event.type === 'auto_retry_start') {
        assert.equal(other._willRetryAfterAgentEnd({ messages: [{ role: 'assistant', provider: 'anthropic', stopReason: 'error', errorMessage: 'Server error' }] }), false);
      }
    });
    const message = await h.failure();
    assert.equal(await h.session._prepareRetry(message), true);
    assert.equal(h.settings.getRetrySettings().maxRetries, 3);
  } finally { await h.close(); }
});
