import test from 'node:test';
import assert from 'node:assert/strict';

import {
  available,
  buildArgs,
  dbmFromPercent,
  parseNetworks,
  rejectArguments,
  run,
  summarize,
  type,
} from '../src/agent/handlers/wifi-survey.js';
import { HandlerRegistry } from '../src/agent/handlers/index.js';
import { ProtocolError } from '../src/common/protocol.js';

/** Real `netsh wlan show networks mode=bssid` output, trimmed to three networks. */
const NETSH = `
Interface name : Wi-Fi
There are 3 networks currently visible.

SSID 1 : VM1234567
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP
    BSSID 1                 : A4:B1:C2:D3:E4:F5
         Signal             : 92%
         Radio type         : 802.11ac
         Band               : 5 GHz
         Channel            : 44
         Basic rates (Mbps) : 6 12 24
         Other rates (Mbps) : 9 18 36 48 54
    BSSID 2                 : A4:B1:C2:D3:E4:F6
         Signal             : 60%
         Radio type         : 802.11n
         Band               : 2.4 GHz
         Channel            : 6
         Basic rates (Mbps) : 1 2 5.5 11

SSID 2 :
    Network type            : Infrastructure
    Authentication          : WPA3-Personal
    Encryption              : CCMP
    BSSID 1                 : 11:22:33:44:55:66
         Signal             : 24%
         Radio type         : 802.11ax
         Band               : 5 GHz
         Channel            : 100

SSID 3 : BTWifi-X
    Network type            : Infrastructure
    Authentication          : Open
    Encryption              : None
    BSSID 1                 : de:ad:be:ef:00:01
         Signal             : 8%
         Radio type         : 802.11n
         Band               : 2.4 GHz
         Channel            : 11
`;

test('a survey reads every radio, not just every network name', () => {
  const networks = parseNetworks(NETSH);

  assert.equal(networks.length, 3);
  assert.equal(networks[0].ssid, 'VM1234567');
  assert.equal(networks[0].authentication, 'WPA2-Personal');

  // Two radios under one name is the ordinary case for a dual-band router, and
  // the pair is the whole point: same AP, different band, different reach.
  assert.equal(networks[0].bssids.length, 2);
  assert.deepEqual(
    networks[0].bssids.map((b) => [b.bssid, b.band, b.channel]),
    [
      ['a4:b1:c2:d3:e4:f5', '5 GHz', 44],
      ['a4:b1:c2:d3:e4:f6', '2.4 GHz', 6],
    ],
  );
});

test('a network that does not broadcast its name is recorded, not dropped', () => {
  const networks = parseNetworks(NETSH);
  const hidden = networks[1];

  assert.equal(hidden.ssid, null);
  assert.equal(hidden.hidden, true);
  // An AP you can hear but cannot name is still a radio in the room, and its
  // signal is still a measurement.
  assert.equal(hidden.bssids[0].bssid, '11:22:33:44:55:66');
  assert.equal(hidden.bssids[0].signalPercent, 24);
});

test('signal is carried in dBm as well as the percentage Windows reports', () => {
  // Windows maps quality to dBm linearly: 0% = -100 dBm, 100% = -50 dBm.
  assert.equal(dbmFromPercent(0), -100);
  assert.equal(dbmFromPercent(100), -50);
  assert.equal(dbmFromPercent(92), -54);

  const networks = parseNetworks(NETSH);
  assert.equal(networks[0].bssids[0].signalDbm, -54);
  assert.equal(networks[2].bssids[0].signalDbm, -96);
});

test('the summary ranks radios by signal, which is what a walked survey compares', () => {
  const summary = summarize(parseNetworks(NETSH));

  assert.deepEqual(summary.counts, { networks: 3, radios: 4, hidden: 1 });
  assert.equal(summary.strongest[0].bssid, 'a4:b1:c2:d3:e4:f5');
  assert.equal(summary.strongest.at(-1).bssid, 'de:ad:be:ef:00:01');
  // Channels, because two APs shouting on channel 6 is its own answer.
  assert.deepEqual(summary.channels, { 44: 1, 6: 1, 100: 1, 11: 1 });
});

test('a payload is refused rather than ignored', () => {
  assert.doesNotThrow(() => rejectArguments(undefined));
  assert.doesNotThrow(() => rejectArguments({}));

  // The argv is a constant, so a caller who thought this filtered by SSID must
  // be told it did not — silently returning everything would look like a
  // filter that matched everything.
  assert.throws(() => rejectArguments({ ssid: 'home' }), ProtocolError);
  assert.throws(() => rejectArguments({ ssid: 'x"; shutdown /r' }), /takes no arguments/);
});

test('run refuses a payload before it spawns anything', async () => {
  // Reaches the argument check and stops there, so this is safe on a machine
  // with no netsh: the rejection happens before the spawn.
  await assert.rejects(() => run({ channel: 6 }), /takes no arguments/);
});

test('the argv netsh is given is pinned', () => {
  assert.deepEqual(buildArgs(), ['wlan', 'show', 'networks', 'mode=bssid']);
});

test('this machine declines the capability rather than failing tasks of it', () => {
  const check = available();

  if (process.platform === 'win32') {
    assert.equal(typeof check.ok, 'boolean');
  } else {
    // .env.agent gets copied between machines, so a Linux agent will be handed
    // ALPHA_EXTRA_HANDLERS=wifi-survey sooner or later. Winning the task and
    // then failing it costs an attempt and the retry lands right back here.
    assert.equal(check.ok, false);
    assert.match(check.reason, /Windows-only/);
  }
});

test('wifi.survey is opt-in, and a machine that cannot run it is left out', () => {
  const registry = new HandlerRegistry();
  assert.equal(registry.has(type), false, 'it drives an external program, so it is not a built-in');

  const result = registry.add({ type, run, available });
  if (process.platform === 'win32') return;
  assert.equal(result.registered, false);
  assert.equal(registry.has(type), false);
  assert.match(result.reason, /Windows-only/);
});
