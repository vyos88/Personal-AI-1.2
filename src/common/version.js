// The release both machines are meant to be running, as opposed to
// PROTOCOL_VERSION's wire contract.
//
// Two checkouts can speak protocol 1 and still differ — a laptop that was
// never `git pull`ed carries older handlers, older defaults and older bugs,
// and nothing in the wire format notices. Agents report this string on
// registration so the host can record it, `alpha-admin agents` can show it,
// and a drifted machine is a line of output rather than a puzzling failure
// halfway through a task.
//
// package.json is the single source of truth: bump it there and both sides
// follow.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : 'unknown';
  } catch {
    // A packaged or trimmed checkout without package.json still runs; it just
    // cannot say which release it is.
    return 'unknown';
  }
}

export const ALPHA_VERSION = readVersion();
