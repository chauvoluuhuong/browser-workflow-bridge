// What bridge_status tells the user to do when the bridge is not connected.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLocal, nextSteps, PRODUCTION, reachable } from '../src/guide.js';

const text = (s) => nextSteps(s).join('\n');

test('connected: nothing to do', () => {
  assert.deepEqual(nextSteps({ state: 'connected', server: PRODUCTION, token: true }), []);
});

test('no token: connect, get a token, paste it in the plugin settings, never in the chat', () => {
  const t = text({ state: 'not_configured', server: PRODUCTION, token: false, serverUp: true });
  assert.match(t, /\/mcp, choose "browser-workflow", then Authenticate/);
  assert.match(t, /New bridge token/);
  assert.match(t, /\/plugin configure browser-workflow-bridge/);
  assert.doesNotMatch(t, /does not answer|Nothing answers/);
});

test('no token and no server: the server comes first', () => {
  const t = text({ state: 'not_configured', server: 'http://127.0.0.1:3310', token: false, serverUp: false });
  assert.ok(t.indexOf('Nothing answers at http://127.0.0.1:3310') < t.indexOf('1. Connect'));
  assert.match(t, new RegExp(`set Server to ${PRODUCTION}`));
});

test('a server that can\'t be reached: a local one is to be started, the hosted one is waited for', () => {
  assert.match(text({ state: 'disconnected', server: 'http://localhost:3310', token: true, lastError: 'Could not reach http://localhost:3310' }), /development address/);
  const hosted = text({ state: 'disconnected', server: PRODUCTION, token: true, serverUp: false });
  assert.match(hosted, /keeps trying by itself/);
  assert.doesNotMatch(hosted, /development/);
});

test('refused: the reason, and both ways out', () => {
  const t = text({ state: 'rejected', server: PRODUCTION, token: true, lastError: 'Another bridge took over.' });
  assert.match(t, /Another bridge took over\./);
  assert.match(t, /action "resume"/);
  assert.match(t, /New bridge token/);
});

test('paused: resume', () => {
  assert.match(text({ state: 'paused', server: PRODUCTION, token: true }), /resume/);
});

test('isLocal and reachable', async () => {
  assert.equal(isLocal('http://127.0.0.1:3310'), true);
  assert.equal(isLocal('http://localhost:8080/'), true);
  assert.equal(isLocal(PRODUCTION), false);
  assert.equal(isLocal('not a url'), false);
  // A port nothing listens on.
  assert.equal(await reachable('http://127.0.0.1:9', 500), false);
});
