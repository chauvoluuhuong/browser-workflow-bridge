// What bridge_status tells the user (and Claude) to do when the app is not connected.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectorHint, isLocal, nextSteps, PRODUCTION, reachable } from '../src/guide.js';

const text = (s) => nextSteps(s).join('\n');
const waiting = { state: 'waiting', code: 'ABCD-EFGH', expiresAt: Date.now() + 9 * 60_000 };

test('connected: nothing to do', () => {
  assert.deepEqual(nextSteps({ state: 'connected', server: PRODUCTION, token: true }), []);
});

test('not linked: the pairing code goes to link_computer, and the user only clicks a button', () => {
  const t = text({ state: 'not_configured', server: PRODUCTION, token: false, serverUp: true, pairing: waiting });
  assert.match(t, /Pairing code: ABCD-EFGH \(valid for about 9 more minutes\)/);
  assert.match(t, /`link_computer` with code "ABCD-EFGH"/);
  assert.match(t, /"Link this computer" button/);
  assert.doesNotMatch(t, /paste|copy a token/i);
});

test('not linked, and no connector yet: how to add it in chat and in Claude Code', () => {
  const t = text({ state: 'not_configured', server: PRODUCTION, token: false, serverUp: true, pairing: waiting });
  assert.match(t, new RegExp(`Settings → Connectors → Add custom connector, address ${PRODUCTION}/mcp`));
  assert.match(t, /\/mcp, choose "browser-workflow", then Authenticate/);
});

test('not linked and no server: the server comes first, with no code to give', () => {
  const t = text({ state: 'not_configured', server: 'http://127.0.0.1:3310', token: false, serverUp: false, pairing: { state: 'unreachable' } });
  assert.match(t, /Nothing answers at http:\/\/127\.0\.0\.1:3310/);
  assert.match(t, new RegExp(`set Server to ${PRODUCTION}`));
  assert.doesNotMatch(t, /link_computer/);
});

test('the server answers but refuses the pairing request: not "does not answer"', () => {
  const t = text({ state: 'not_configured', server: PRODUCTION, token: false, serverUp: true, pairing: { state: 'unreachable', lastError: 'The server answered 404 to the pairing request' } });
  assert.match(t, /The server answers, but not to the pairing request/);
  assert.doesNotMatch(t, /does not answer/);
});

test('a code not asked for yet', () => {
  assert.match(text({ state: 'not_configured', server: PRODUCTION, token: false, serverUp: true, pairing: { state: 'asking' } }), /Getting a pairing code/);
});

test('a server that can\'t be reached: a local one is to be started, the hosted one is waited for', () => {
  assert.match(text({ state: 'disconnected', server: 'http://localhost:3310', token: true, lastError: 'Could not reach http://localhost:3310' }), /development address/);
  const hosted = text({ state: 'disconnected', server: PRODUCTION, token: true, serverUp: false });
  assert.match(hosted, /keeps trying by itself/);
  assert.doesNotMatch(hosted, /development/);
});

test('refused: the reason, and the way to take the account back', () => {
  const t = text({ state: 'rejected', server: PRODUCTION, token: true, lastError: 'Another bridge took over.' });
  assert.match(t, /Another bridge took over\./);
  assert.match(t, /action "resume"/);
});

test('paused: resume', () => {
  assert.match(text({ state: 'paused', server: PRODUCTION, token: true }), /resume/);
});

test('connected but no connector tools: how to add the connector', () => {
  assert.match(connectorHint(PRODUCTION), /Add custom connector/);
});

test('isLocal and reachable', async () => {
  assert.equal(isLocal('http://127.0.0.1:3310'), true);
  assert.equal(isLocal('http://localhost:8080/'), true);
  assert.equal(isLocal(PRODUCTION), false);
  assert.equal(isLocal('not a url'), false);
  assert.equal(await reachable('http://127.0.0.1:9', 500), false);
});
