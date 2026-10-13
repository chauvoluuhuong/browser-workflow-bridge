// Which kind of link a computer has (src/pairing.js): one a user made, or the key of an account the app asked for itself.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { linkedByUser, readLink, saveLink } from '../src/pairing.js';

test('a link made by a user is told from the key of the app\'s own account', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bw-link-'));
  assert.equal(linkedByUser(dir, 'https://s.test'), false);
  saveLink(dir, 'https://s.test', 'bwb_user');
  assert.equal(linkedByUser(dir, 'https://s.test'), true);
  assert.equal(linkedByUser(dir, 'https://other.test'), false);
  saveLink(dir, 'https://s.test', 'bwb_own', true);
  assert.equal(linkedByUser(dir, 'https://s.test'), false);
  assert.equal(readLink(dir, 'https://s.test'), 'bwb_own');
});
