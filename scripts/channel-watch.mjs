#!/usr/bin/env node
/**
 * Is every status channel still talking? One read of the status branches this
 * machine's checkout can fetch, and a verdict per channel.
 *
 * On 2026-10-07 Laptop41's autopilot stopped pushing at 23:24 UTC, and the
 * first thing to notice was a cloud session three hours later: every report
 * is written by the machine it is about, so a machine that stops writing
 * also stops saying so. Something else has to read the silence. Run by the
 * Host's autopilot as a standing check (autofix.channelWatch), it turns a
 * quiet channel into a line in the Host's own report.
 *
 *   node scripts/channel-watch.mjs --channels laptop41-live:30,laptop41:45 [--repo <dir>]
 *
 * Each channel is status/<name> on origin, with the minutes after which its
 * last commit counts as silent. Output, one line per channel, verdict first
 * and no ages in it, so the autopilot can report only a change:
 *   OK: status/laptop41-live
 *   SILENT: status/laptop41 (last write 2026-10-08T00:24:00Z)
 *   MISSING: status/nowhere
 * followed by one detail line with every age.
 *
 * Exit 0 every channel talking, 2 one is silent or missing, 1 could not run.
 * It only fetches status/* refs and reads commit times; it writes nothing.
 */

import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** "a:30,b:45" -> [{ name: 'a', staleMin: 30 }, ...]; throws on anything else. */
export function parseChannels(spec) {
  const out = [];
  for (const part of String(spec ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const [name, minutes] = part.split(':');
    const staleMin = Number(minutes);
    if (!NAME.test(name ?? '') || !Number.isInteger(staleMin) || staleMin < 5 || staleMin > 1440) {
      throw new Error(`channel must be name:minutes (5-1440), not ${JSON.stringify(part)}`);
    }
    out.push({ name, staleMin });
  }
  if (!out.length) throw new Error('no channels given');
  return out;
}

/** Pure: a verdict per channel from its last commit time (epoch seconds or null). */
export function judgeChannels(channels, lastWrites, nowMs) {
  return channels.map(({ name, staleMin }) => {
    const at = lastWrites[name];
    if (!at) return { name, verdict: 'MISSING', ageMin: null };
    const ageMin = Math.floor((nowMs - at * 1000) / 60_000);
    return { name, verdict: ageMin > staleMin ? 'SILENT' : 'OK', ageMin, at, staleMin };
  });
}

export function formatReport(results) {
  const lines = results.map((r) =>
    r.verdict === 'SILENT'
      ? `SILENT: status/${r.name} (last write ${new Date(r.at * 1000).toISOString().replace(/\.\d+Z$/, 'Z')})`
      : `${r.verdict}: status/${r.name}`,
  );
  lines.push(
    '  ages: ' +
      results.map((r) => `${r.name} ${r.ageMin === null ? 'never' : `${r.ageMin} min`} (silent after ${r.staleMin ?? '?'})`).join(', '),
  );
  return lines.join('\n');
}

function lastWrite(repo, name) {
  try {
    execFileSync('git', ['-C', repo, 'fetch', '--quiet', 'origin', `+refs/heads/status/${name}:refs/remotes/origin/status/${name}`], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 60_000,
    });
  } catch (error) {
    // A branch that does not exist on origin is MISSING, not a failure to run.
    if (/couldn't find remote ref|not our ref|no such ref/i.test(`${error.stderr ?? ''}`)) return null;
    throw new Error(`git fetch status/${name} failed: ${`${error.stderr ?? error.message}`.trim().split('\n')[0]}`);
  }
  const out = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%ct', `refs/remotes/origin/status/${name}`], {
    encoding: 'utf8',
    timeout: 30_000,
  }).trim();
  return out ? Number(out) : null;
}

function main(argv) {
  const args = { repo: resolve(dirname(fileURLToPath(import.meta.url)), '..') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--channels') args.channels = argv[++i];
    else if (argv[i] === '--repo') args.repo = resolve(argv[++i]);
    else if (argv[i] === '--now') args.now = Number(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  const channels = parseChannels(args.channels);
  const writes = {};
  for (const c of channels) writes[c.name] = lastWrite(args.repo, c.name);
  const results = judgeChannels(channels, writes, args.now || Date.now());
  process.stdout.write(`${formatReport(results)}\n`);
  return results.some((r) => r.verdict !== 'OK') ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stdout.write(`could not run: ${error.message}\n`);
    process.exitCode = 1;
  }
}
