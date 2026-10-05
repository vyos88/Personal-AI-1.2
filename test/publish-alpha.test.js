import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { walk, scanForSecrets, suggestedIgnore } from '../scripts/publish-alpha.mjs';

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'publish-alpha-test-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

test("Alpha's own local credentials are flagged, by name and by place", () => {
  const root = tree({
    'memory/local/alpha-local-service.credential.xml': '<Objs/>',
    'memory/local/steward-auth-backoff.json': '{}',
    'memory/local/deck-improvement/visual-capture.token': 'x',
    'software/backend/memory/alpha.db': 'SQLite format 3',
    'memory/local/gmail_credentials.enc': 'x',
    'software/backend/main.py': 'print("hello")\n',
    'memory/knowledge/record.json': '{"note": "plain knowledge"}',
  });
  const flagged = new Set(scanForSecrets(walk(root).files).map((f) => f.rel.replace(/\\/g, '/')));
  for (const rel of [
    'memory/local/alpha-local-service.credential.xml',
    'memory/local/steward-auth-backoff.json',
    'memory/local/deck-improvement/visual-capture.token',
    'software/backend/memory/alpha.db',
    'memory/local/gmail_credentials.enc',
  ]) assert.ok(flagged.has(rel), `${rel} must be flagged`);
  assert.ok(!flagged.has('software/backend/main.py'));
  assert.ok(!flagged.has('memory/knowledge/record.json'), 'shared knowledge is not local state');
});

test('a saved PowerShell credential is flagged anywhere, not only under memory/local', () => {
  const root = tree({ 'scripts/old/owner.credential.xml': '<Objs/>' });
  assert.equal(scanForSecrets(walk(root).files).length, 1);
});

test('the suggested .gitignore keeps them out of the first commit', () => {
  const ignore = suggestedIgnore(new Map()).split('\n');
  for (const line of ['memory/local/', '*.credential.xml', '*.db', '*.enc', 'auth.json']) {
    assert.ok(ignore.includes(line), `missing ${line}`);
  }
});
