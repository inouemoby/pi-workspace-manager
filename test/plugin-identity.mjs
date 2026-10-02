import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalGitIdentity, canonicalPluginIdentity } from '../plugin-identity.ts';

test('git branch and source URL variants resolve to one plugin identity', () => {
  const expected = 'git:github.com/inouemoby/pi-antigravity-usage';
  assert.equal(canonicalGitIdentity('git:github.com/inouemoby/pi-antigravity-usage'), expected);
  assert.equal(canonicalGitIdentity('git:github.com/inouemoby/pi-antigravity-usage@main'), expected);
  assert.equal(canonicalGitIdentity('github:inouemoby/pi-antigravity-usage'), expected);
  assert.equal(canonicalGitIdentity('https://github.com/inouemoby/pi-antigravity-usage.git'), expected);
  assert.equal(canonicalGitIdentity('git@github.com:inouemoby/pi-antigravity-usage.git'), expected);
});

test('local checkouts use their repository identity without treating paths as Git URLs', () => {
  assert.equal(canonicalGitIdentity('C:/Users/36190/.pi/agent/git/github.com/inouemoby/plugin'), undefined);
  assert.equal(
    canonicalPluginIdentity('C:/Users/36190/.pi/agent/git/github.com/inouemoby/plugin', 'plugin',
      'https://github.com/inouemoby/plugin.git'),
    'git:github.com/inouemoby/plugin',
  );
});

test('different Git repositories remain separate and branch suffixes do not duplicate fallback names', () => {
  assert.notEqual(
    canonicalPluginIdentity('git:github.com/other/pi-antigravity-usage', 'pi-antigravity-usage'),
    canonicalPluginIdentity('git:github.com/inouemoby/pi-antigravity-usage', 'pi-antigravity-usage'),
  );
  assert.equal(canonicalPluginIdentity('local-copy', 'tool@main'), canonicalPluginIdentity('other-copy', 'tool'));
});
