import test from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultReserveBytes,
  normalizeHostUrl,
  parseMegabytes,
  renderAgentEnv,
  serviceHint,
} from '../scripts/setup-agent.mjs';
import { maxLoadFromEnv, concurrencyFromEnv } from '../src/agent/load.js';
import { reserveFromEnv } from '../src/agent/memory.js';
import { MB } from '../src/common/protocol.js';

const gb = (n) => n * 1024 * MB;

test('the default reserve is a quarter of the machine, floored and capped', () => {
  assert.equal(defaultReserveBytes(gb(16)), gb(4));
  // A small machine still keeps a working floor rather than a literal quarter.
  assert.equal(defaultReserveBytes(gb(1)), 512 * MB);
  // A large one does not sit on 16 GB of itself.
  assert.equal(defaultReserveBytes(gb(64)), 4096 * MB);
});

test('the host URL is normalized, and anything that is not one is refused', () => {
  assert.equal(normalizeHostUrl('http://100.1.2.3:8787/'), 'http://100.1.2.3:8787');
  assert.equal(normalizeHostUrl('  https://alpha.example:8787/path  '), 'https://alpha.example:8787');
  assert.throws(() => normalizeHostUrl(''), /--host is required/);
  assert.throws(() => normalizeHostUrl(undefined), /--host is required/);
  assert.throws(() => normalizeHostUrl('alpha-host:8787'), /not a URL|must be http/);
  assert.throws(() => normalizeHostUrl('file:///etc/passwd'), /must be http/);
});

test('megabyte flags must be whole, non-negative numbers', () => {
  assert.equal(parseMegabytes(undefined, '--reserve-mb'), null);
  assert.equal(parseMegabytes('2048', '--reserve-mb'), 2048);
  assert.throws(() => parseMegabytes('1.5', '--reserve-mb'), /whole number/);
  assert.throws(() => parseMegabytes('-1', '--reserve-mb'), /whole number/);
  assert.throws(() => parseMegabytes('plenty', '--reserve-mb'), /whole number/);
});

test('the written configuration carries the host, key and reserve', () => {
  const env = renderAgentEnv({
    hostUrl: 'http://100.1.2.3:8787',
    key: 'alpha_key_abc.def',
    name: 'laptop',
    reserveMB: 2048,
  });

  assert.match(env, /^ALPHA_HOST_URL=http:\/\/100\.1\.2\.3:8787$/m);
  assert.match(env, /^ALPHA_AGENT_KEY=alpha_key_abc\.def$/m);
  assert.match(env, /^ALPHA_AGENT_NAME=laptop$/m);
  assert.match(env, /^ALPHA_AGENT_MEMORY_RESERVE_MB=2048$/m);
  // Off unless asked for: holding data costs the RAM it costs.
  assert.doesNotMatch(env, /ALPHA_EXTRA_HANDLERS/);
  assert.doesNotMatch(env, /ALPHA_AGENT_CAPABILITIES/);
});

test('the written configuration carries the load ceiling and concurrency', () => {
  // Without these the laptop is enrolled with no load settings at all, which
  // is how a machine ends up taking work while it is already pinned.
  const env = renderAgentEnv({ hostUrl: 'http://h:1', key: 'k', reserveMB: 512 });
  assert.match(env, /^ALPHA_AGENT_MAX_LOAD=0\.85$/m);
  assert.match(env, /^ALPHA_AGENT_CONCURRENCY=1$/m);

  const tuned = renderAgentEnv({
    hostUrl: 'http://h:1',
    key: 'k',
    reserveMB: 512,
    maxLoad: 0.6,
    concurrency: 4,
  });
  assert.match(tuned, /^ALPHA_AGENT_MAX_LOAD=0\.6$/m);
  assert.match(tuned, /^ALPHA_AGENT_CONCURRENCY=4$/m);
});

test('what setup writes is what the agent will actually start with', () => {
  // The two sides parse these independently, so a value setup happily writes
  // could be one the agent refuses on first run. Same parsers, no drift.
  const env = renderAgentEnv({
    hostUrl: 'http://h:1',
    key: 'k',
    reserveMB: 512,
    maxLoad: maxLoadFromEnv('0.7', 0.85),
    concurrency: concurrencyFromEnv('3', 1),
  });
  const read = (name) => new RegExp(`^${name}=(.*)$`, 'm').exec(env)[1];
  assert.equal(maxLoadFromEnv(read('ALPHA_AGENT_MAX_LOAD'), 0.85), 0.7);
  assert.equal(concurrencyFromEnv(read('ALPHA_AGENT_CONCURRENCY'), 1), 3);
  assert.equal(reserveFromEnv(read('ALPHA_AGENT_MEMORY_RESERVE_MB')), 512 * MB);
});

test('the store and a capability list are written only when asked for', () => {
  const env = renderAgentEnv({
    hostUrl: 'http://h:1',
    key: 'k',
    reserveMB: 512,
    capabilities: 'echo,memory.store',
    memstore: true,
    memstoreMB: 1024,
  });

  assert.match(env, /^ALPHA_AGENT_CAPABILITIES=echo,memory\.store$/m);
  assert.match(env, /^ALPHA_EXTRA_HANDLERS=memstore$/m);
  assert.match(env, /^ALPHA_MEMSTORE_LIMIT_MB=1024$/m);

  // Without a budget the agent picks its own, so nothing is pinned.
  const unbudgeted = renderAgentEnv({ hostUrl: 'http://h:1', key: 'k', reserveMB: 512, memstore: true });
  assert.match(unbudgeted, /^ALPHA_EXTRA_HANDLERS=memstore$/m);
  assert.doesNotMatch(unbudgeted, /ALPHA_MEMSTORE_LIMIT_MB/);
});

test('the closing advice matches the machine it printed on', () => {
  const args = { node: '/usr/bin/node', root: '/srv/alpha-tunnel' };
  assert.match(serviceHint('win32', args), /nssm install alpha-agent/);
  assert.match(serviceHint('darwin', args), /launchctl/);
  assert.match(serviceHint('linux', args), /systemctl --user/);
  // Every one of them points at this checkout's agent entrypoint.
  for (const platform of ['win32', 'darwin', 'linux']) {
    assert.match(serviceHint(platform, args), /src[\\/]agent[\\/]index\.js/);
  }
});
