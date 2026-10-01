// crowpanel.ino — the CrowPanel shows a live alpha-tunnel report.
//
// Two jobs, and they are deliberately separate:
//
//   1. Take credentials over the serial line and keep them in NVS. The panel is
//      provisioned by the `alpha.panel` handler sending one JSON line down USB
//      — it is never reflashed to change networks. That is why no WiFi password
//      is in this file and none must ever be put in it: firmware is built,
//      cached and copied around, and a secret compiled into it leaks everywhere
//      the binary goes.
//
//   2. Poll the coordinator and draw what it says. Read-only. The panel asks
//      questions and renders answers; it queues nothing, claims nothing, and
//      holds no lease. A display that could dispatch work would be a second
//      coordinator with a screen.
//
// It knows more than one of each thing, because everything it depends on is
// something that goes away:
//
//   - **Several networks.** A laptop moves between the house WiFi and a
//     hotspot; a panel that knows one of them is dark for the other. It keeps
//     up to PANEL_MAX_NETWORKS and picks by signal, not by the order they were
//     given: the strongest one the radio can actually see wins, so the panel
//     does not sit retrying a network two rooms away.
//   - **Two coordinators.** `host` is the usual one and `host2` the standby
//     that runs while the host is off. The primary is tried first on every
//     poll, so coming home needs no signal to arrive and nothing to notice.
//
// Provisioning protocol — newline-delimited JSON in, newline-delimited JSON out:
//
//   {"cmd":"wifi","ssid":"...","password":"..."}
//   {"cmd":"wifi","networks":[{"ssid":"a","password":"1"},{"ssid":"b"}]}
//                        -> {"ok":true,"cmd":"wifi","ssid":"a","ip":"...","rssi":-54}
//   {"cmd":"alpha","host":"http://...","host2":"http://...","key":"alpha_key_..."}
//                        -> {"ok":true,"cmd":"alpha","host":"...","host2":"..."}
//   {"cmd":"scan"}       -> {"ok":true,"cmd":"scan","networks":[{"ssid":"a","rssi":-54}]}
//   {"cmd":"status"}     -> {"ok":true,"cmd":"status","ssid":"a","ip":"...", ...}
//
// `scan` is what makes provisioning answerable rather than a guess: it reports
// what this radio can see from where the panel actually is, which is not the
// same as what the laptop beside it can see.
//
// Every reply carries `ok` or `error`, because that is what the handler waits
// for before it stops reading, and `cmd`, so a reply can be matched to the
// command it answers rather than to whichever command was in flight. A board
// that answers nothing looks identical to one that is not there, so silence is
// the one thing this must not do.
//
// Libraries (Arduino IDE -> Library Manager):
//   ArduinoJson    (Benoit Blanchon)
//   TFT_eSPI       (Bodmer)  — see display.h; this is the board-specific half.

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <ArduinoJson.h>

#include "display.h"

// Printed in the footer and reported by `status`, so "which firmware is on that
// board" is answerable from the wire instead of from memory.
static const char* PANEL_FIRMWARE = "panel-2";

// How often to ask the coordinator for a fresh report. The host holds this in
// memory and answers instantly, but a panel polling every second would add a
// request per second to a box whose job is dispatching work.
static const uint32_t POLL_INTERVAL_MS = 5000;
// How long a report stays worth showing. Past this the numbers are still drawn
// but marked stale: a frozen screen that looks live is the failure a status
// display must not have.
static const uint32_t REPORT_STALE_MS  = 20000;
static const uint32_t WIFI_RETRY_MS    = 15000;
static const uint16_t HTTP_TIMEOUT_MS  = 4000;
static const uint32_t JOIN_TIMEOUT_MS  = 12000;

// Four is a house, a hotspot, a neighbour's guest network and one spare. More
// would not fit the join budget: every one that is tried and fails is seconds
// the screen is dark.
static const uint8_t PANEL_MAX_NETWORKS = 4;

// NVS namespace. Credentials live here and nowhere else on the device.
static Preferences prefs;

struct Network {
  String ssid;
  String password;
};

static Network networks[PANEL_MAX_NETWORKS];
static uint8_t networkCount = 0;

static String alphaHost;
static String alphaStandby;   // where Alpha runs while the host is off
static String alphaKey;
static bool   onStandby = false;

static String joinedSsid;     // the one actually connected, not the one asked for
static uint32_t lastPoll = 0;
static uint32_t lastWifiAttempt = 0;

// The last thing we successfully read, so the screen keeps showing the previous
// report while a poll is in flight or failing, rather than blanking. A display
// that goes empty when the network hiccups reads as "everything is down".
struct Report {
  bool     valid     = false;
  uint32_t agents    = 0;   // attached agents; the host prunes stale ones itself
  uint32_t queued    = 0;
  uint32_t running   = 0;   // leased: held by an agent right now
  uint32_t completed = 0;
  uint32_t failed    = 0;
  uint32_t blocked   = 0;   // queued and waiting on memory, not on a machine
  String   version;
  String   error;
  uint32_t fetchedAt = 0;
};

static Report report;

// ---------------------------------------------------------------- persistence

// Networks are stored as one JSON array under "nets". The alternative — ssid0,
// pass0, ssid1... — needs a separate count key that can disagree with the keys
// it counts, and a half-written set of credentials is a panel that joins
// nothing.
static void loadSettings() {
  prefs.begin("alpha", true);
  const String stored = prefs.getString("nets", "");
  // Migration: a panel provisioned by the previous firmware has one network
  // under the old keys, and reflashing must not cost it the credentials it
  // already has.
  const String legacySsid = prefs.getString("ssid", "");
  const String legacyPass = prefs.getString("pass", "");
  alphaHost    = prefs.getString("host", "");
  alphaStandby = prefs.getString("host2", "");
  alphaKey     = prefs.getString("key", "");
  prefs.end();

  networkCount = 0;
  if (stored.length()) {
    JsonDocument doc;
    if (!deserializeJson(doc, stored)) {
      for (JsonObject entry : doc.as<JsonArray>()) {
        if (networkCount >= PANEL_MAX_NETWORKS) break;
        const char* ssid = entry["ssid"] | "";
        if (strlen(ssid) == 0) continue;
        networks[networkCount].ssid = String(ssid);
        networks[networkCount].password = String(entry["password"] | "");
        networkCount++;
      }
    }
  }
  if (networkCount == 0 && legacySsid.length()) {
    networks[0].ssid = legacySsid;
    networks[0].password = legacyPass;
    networkCount = 1;
  }
}

static void saveNetworks() {
  JsonDocument doc;
  JsonArray array = doc.to<JsonArray>();
  for (uint8_t i = 0; i < networkCount; i++) {
    JsonObject entry = array.add<JsonObject>();
    entry["ssid"] = networks[i].ssid;
    entry["password"] = networks[i].password;
  }
  String encoded;
  serializeJson(doc, encoded);

  prefs.begin("alpha", false);
  prefs.putString("nets", encoded);
  // The old keys are cleared rather than left behind: credentials for a network
  // nobody meant to keep are still credentials.
  prefs.remove("ssid");
  prefs.remove("pass");
  prefs.end();
}

static void saveAlpha(const String& host, const String& standby, const String& key) {
  prefs.begin("alpha", false);
  prefs.putString("host", host);
  prefs.putString("host2", standby);
  prefs.putString("key", key);
  prefs.end();
  alphaHost = host;
  alphaStandby = standby;
  alphaKey = key;
}

// ----------------------------------------------------------------------- wifi

/**
 * Joins one network, or gives up inside the budget.
 *
 * Blocking, but only for as long as a join reasonably takes. The panel has
 * nothing else to do until it is on a network, and the serial reader is polled
 * again the moment this returns either way.
 */
static bool joinOne(const Network& network, uint32_t timeoutMs) {
  if (network.ssid.length() == 0) return false;

  WiFi.mode(WIFI_STA);
  WiFi.begin(network.ssid.c_str(),
             network.password.length() ? network.password.c_str() : nullptr);

  const uint32_t started = millis();
  while (millis() - started < timeoutMs) {
    const wl_status_t status = WiFi.status();
    if (status == WL_CONNECTED) {
      joinedSsid = network.ssid;
      return true;
    }
    // A wrong password comes back as CONNECT_FAILED long before the timeout.
    // Waiting out the budget for it would spend the other networks' seconds on
    // one that is never going to work.
    if (status == WL_CONNECT_FAILED || status == WL_NO_SSID_AVAIL) break;
    delay(200);
  }
  WiFi.disconnect(true);
  return false;
}

/**
 * Joins the best network this radio can actually see.
 *
 * The order they were provisioned in is not the order to try them: the house
 * WiFi provisioned first is the wrong first choice in a room where only the
 * hotspot reaches. So this scans, keeps the known networks that appeared,
 * sorts them by signal, and tries those. Only if the scan found none of them —
 * which is also what a hidden SSID looks like — does it fall back to trying
 * everything in the order it was given.
 */
static bool joinBest() {
  if (networkCount == 0) return false;
  joinedSsid = "";

  const int16_t found = WiFi.scanNetworks(false, true);
  int8_t order[PANEL_MAX_NETWORKS];
  int32_t strength[PANEL_MAX_NETWORKS];
  uint8_t seen = 0;

  for (uint8_t i = 0; i < networkCount && found > 0; i++) {
    int32_t best = -32768;
    bool present = false;
    for (int16_t j = 0; j < found; j++) {
      if (WiFi.SSID(j) != networks[i].ssid) continue;
      present = true;
      if (WiFi.RSSI(j) > best) best = WiFi.RSSI(j);
    }
    if (!present) continue;
    // Insertion sort: four entries, and it keeps the strongest first without
    // a second pass.
    uint8_t at = seen;
    while (at > 0 && strength[at - 1] < best) {
      order[at] = order[at - 1];
      strength[at] = strength[at - 1];
      at--;
    }
    order[at] = i;
    strength[at] = best;
    seen++;
  }
  WiFi.scanDelete();

  if (seen > 0) {
    for (uint8_t i = 0; i < seen; i++) {
      if (joinOne(networks[order[i]], JOIN_TIMEOUT_MS)) return true;
    }
    return false;
  }

  // Nothing known was in the scan. Hidden SSIDs do not appear in one, so this
  // is not the same as "there is no network here".
  for (uint8_t i = 0; i < networkCount; i++) {
    if (joinOne(networks[i], JOIN_TIMEOUT_MS)) return true;
  }
  return false;
}

// ------------------------------------------------------------------ reporting

// One attempt against one coordinator. Returns false if it could not be read,
// with report.error saying why — the caller decides whether to try the other.
static bool pollOne(const String& base) {
  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setConnectTimeout(HTTP_TIMEOUT_MS);

  String url = base + "/stats";
  if (!http.begin(url)) { report.error = "bad url"; return false; }
  if (alphaKey.length()) http.addHeader("Authorization", "Bearer " + alphaKey);

  const int status = http.GET();
  if (status != 200) {
    // 401 is the one worth naming: it means the panel reached the coordinator
    // and was turned away, which is a different job from "the host is down".
    report.error = (status == 401 || status == 403) ? "unauthorized" : ("http " + String(status));
    http.end();
    return false;
  }

  JsonDocument doc;
  const DeserializationError err = deserializeJson(doc, http.getStream());
  http.end();
  if (err) { report.error = "bad json"; return false; }

  // Read with the host's own names, from src/host/server.js:
  //
  //   { version, agents: <count>, capabilities: [...],
  //     queue:  { total, pending, waiters, byStatus: { queued, leased, ... } },
  //     memory: { offeredBytes, blockedTasks }, load: {...} }
  //
  // Guessing at plausible-looking names instead is how a panel ends up showing
  // a confident row of zeroes, which reads as "the fleet is idle" rather than
  // as "this display is reading the wrong keys".
  JsonObject byStatus = doc["queue"]["byStatus"];
  report.version   = doc["version"]            | "";
  report.agents    = doc["agents"]             | 0;
  report.queued    = byStatus["queued"]        | 0;
  report.running   = byStatus["leased"]        | 0;
  report.completed = byStatus["succeeded"]     | 0;
  report.failed    = byStatus["failed"]        | 0;
  report.blocked   = doc["memory"]["blockedTasks"] | 0;
  report.valid     = true;
  report.fetchedAt = millis();
  report.error     = "";
  return true;
}

// Reads GET /stats. That endpoint already summarises the queue and the
// registry, so the panel does no arithmetic of its own — whatever the host
// calls "running" is what the screen says.
//
// The primary first, every time, then the standby. Always starting at the
// primary is what brings the panel home when the host comes back: there is no
// separate "the host is up again" signal to miss, and the cost of being wrong
// is one failed request every five seconds.
static void pollAlpha() {
  report.error = "";

  if (WiFi.status() != WL_CONNECTED) { report.error = "no wifi"; return; }
  if (alphaHost.length() == 0)       { report.error = "no host"; return; }

  if (pollOne(alphaHost)) { onStandby = false; return; }

  if (alphaStandby.length()) {
    const String primaryError = report.error;
    if (pollOne(alphaStandby)) { onStandby = true; return; }
    // Neither answered: name the primary's failure, which is the one that
    // explains why the fleet is on a laptop at all.
    report.error = primaryError;
  }
  onStandby = false;
}

// ------------------------------------------------------------------ rendering

// Four bars' worth of signal, in words, because a number in dBm answers a
// question nobody in the room is asking.
static const char* signalWord(int32_t rssi) {
  if (rssi >= -55) return "strong";
  if (rssi >= -67) return "ok";
  if (rssi >= -75) return "weak";
  return "poor";
}

static void drawReport() {
  displayBegin();

  displayTitle("alpha-tunnel");

  if (WiFi.status() == WL_CONNECTED) {
    displayLine("wifi", joinedSsid + "  " + WiFi.localIP().toString(), DISPLAY_OK);
    displayLine("signal", String(signalWord(WiFi.RSSI())) + "  " + String(WiFi.RSSI()) + " dBm",
                WiFi.RSSI() >= -75 ? DISPLAY_MUTED : DISPLAY_BAD);
  } else if (networkCount == 0) {
    displayLine("wifi", "not provisioned", DISPLAY_BAD);
  } else {
    // Name what it is looking for. "joining" on its own is indistinguishable
    // from a panel that was never told about this network.
    String names = networks[0].ssid;
    for (uint8_t i = 1; i < networkCount; i++) names += ", " + networks[i].ssid;
    displayLine("wifi", "looking for " + names, DISPLAY_BAD);
  }

  const bool stale = report.valid && (millis() - report.fetchedAt) > REPORT_STALE_MS;

  if (report.error.length()) {
    displayLine("host", report.error, DISPLAY_BAD);
  } else if (!report.valid) {
    displayLine("host", "waiting", DISPLAY_MUTED);
  }

  if (report.valid) {
    // Stale numbers are still worth showing — they are the last true thing this
    // panel knew — but they are drawn muted so nobody reads a frozen screen as
    // a quiet fleet.
    const DisplayTone tone = stale ? DISPLAY_MUTED : DISPLAY_NORMAL;
    displayLine("agents", String(report.agents),
                stale ? DISPLAY_MUTED : (report.agents > 0 ? DISPLAY_OK : DISPLAY_BAD));
    // Queued work waiting on RAM rather than on a free machine is worth saying
    // out loud: it is the one backlog that adding a machine does not clear.
    displayLine("queued", report.blocked ? String(report.queued) + "  (" + String(report.blocked) + " on ram)"
                                         : String(report.queued), tone);
    displayLine("running", String(report.running), tone);
    displayLine("done", String(report.completed), DISPLAY_MUTED);
    displayLine("failed", String(report.failed),
                report.failed && !stale ? DISPLAY_BAD : DISPLAY_MUTED);
  }

  // Age rather than a clock: the panel has no RTC, and "14s ago" answers the
  // question a wall-clock time on a frozen screen cannot — is this still live?
  if (report.valid) {
    String footer = String((millis() - report.fetchedAt) / 1000) + "s ago";
    if (report.version.length()) footer = "alpha " + report.version + "  " + footer;
    // Reading the standby is not an error, but it is not the normal state
    // either, and a screen that does not say so hides a host that is off.
    if (onStandby) footer += "  [standby]";
    if (stale) footer += "  [stale]";
    displayFooter(footer);
  } else {
    displayFooter(PANEL_FIRMWARE);
  }

  displayEnd();
}

// --------------------------------------------------------------- provisioning

// Every reply names the command it answers. The handler sends a harmless
// `status` until the board comes back from the reset that opening the port
// caused, so a late answer to one of those probes can otherwise arrive while it
// is waiting for the reply to `wifi` — and be read as one. Naming the command
// is what lets a stale reply be recognised and dropped.
static void reply(JsonDocument& doc, const char* cmd) {
  doc["cmd"] = cmd;
  serializeJson(doc, Serial);
  Serial.println();
  Serial.flush();
}

static void replyError(const char* message, const char* cmd) {
  JsonDocument doc;
  doc["error"] = message;
  reply(doc, cmd);
}

/** Fills the stored set from a `wifi` command, newest wins, capped. */
static uint8_t readNetworks(const JsonDocument& in) {
  uint8_t count = 0;
  JsonArrayConst list = in["networks"].as<JsonArrayConst>();

  if (!list.isNull()) {
    for (JsonObjectConst entry : list) {
      if (count >= PANEL_MAX_NETWORKS) break;
      const char* ssid = entry["ssid"] | "";
      if (strlen(ssid) == 0) continue;
      networks[count].ssid = String(ssid);
      networks[count].password = String(entry["password"] | "");
      count++;
    }
    return count;
  }

  // The single-network form, which is still what one laptop with one WiFi
  // sends, and what every panel provisioned before this firmware used.
  const char* ssid = in["ssid"] | "";
  if (strlen(ssid)) {
    networks[0].ssid = String(ssid);
    networks[0].password = String(in["password"] | "");
    count = 1;
  }
  return count;
}

static void handleCommand(const String& line) {
  JsonDocument in;
  if (deserializeJson(in, line)) { replyError("bad json", ""); return; }

  const char* cmd = in["cmd"] | "";

  if (strcmp(cmd, "wifi") == 0) {
    const uint8_t count = readNetworks(in);
    if (count == 0) { replyError("ssid required", cmd); return; }
    networkCount = count;
    saveNetworks();

    // Join straight away and report the outcome, so the task that sent the
    // credentials learns whether they actually work instead of only that they
    // were stored. A password accepted and silently wrong is the failure this
    // whole flow exists to avoid.
    const bool joined = joinBest();
    JsonDocument out;
    out["ok"] = joined;
    out["known"] = networkCount;
    if (joined) {
      out["ssid"] = joinedSsid;
      out["ip"] = WiFi.localIP().toString();
      out["rssi"] = WiFi.RSSI();
    } else {
      // Name them, so the answer is "none of these three worked" rather than
      // "it did not work".
      out["error"] = "no network joined";
      JsonArray tried = out["tried"].to<JsonArray>();
      for (uint8_t i = 0; i < networkCount; i++) tried.add(networks[i].ssid);
    }
    reply(out, cmd);
    return;
  }

  if (strcmp(cmd, "alpha") == 0) {
    const char* host = in["host"] | "";
    if (strlen(host) == 0) { replyError("host required", cmd); return; }
    // host2 is optional: a fleet with no standby simply has none.
    saveAlpha(String(host), String(in["host2"] | ""), String(in["key"] | ""));
    JsonDocument out;
    out["ok"] = true;
    out["host"] = alphaHost;
    out["host2"] = alphaStandby;
    reply(out, cmd);
    return;
  }

  if (strcmp(cmd, "scan") == 0) {
    // What this radio can see from where the panel is, which is the only
    // opinion that matters and not one the laptop beside it can give.
    const int16_t found = WiFi.scanNetworks(false, true);
    JsonDocument out;
    out["ok"] = found >= 0;
    JsonArray list = out["networks"].to<JsonArray>();
    for (int16_t i = 0; i < found && i < 20; i++) {
      JsonObject entry = list.add<JsonObject>();
      entry["ssid"] = WiFi.SSID(i);
      entry["rssi"] = WiFi.RSSI(i);
      entry["open"] = WiFi.encryptionType(i) == WIFI_AUTH_OPEN;
    }
    if (found < 0) out["error"] = "scan failed";
    WiFi.scanDelete();
    reply(out, cmd);
    // A scan drops the association on some builds; get back on rather than
    // waiting for the retry timer to notice.
    if (WiFi.status() != WL_CONNECTED && networkCount) joinBest();
    return;
  }

  if (strcmp(cmd, "status") == 0) {
    JsonDocument out;
    out["ok"] = true;
    out["firmware"] = PANEL_FIRMWARE;
    out["connected"] = WiFi.status() == WL_CONNECTED;
    out["ssid"] = joinedSsid;
    if (WiFi.status() == WL_CONNECTED) {
      out["ip"] = WiFi.localIP().toString();
      out["rssi"] = WiFi.RSSI();
    }
    JsonArray known = out["known"].to<JsonArray>();
    for (uint8_t i = 0; i < networkCount; i++) known.add(networks[i].ssid);
    out["host"] = alphaHost;
    out["host2"] = alphaStandby;
    out["standby"] = onStandby;
    // Whether a key is set, never the key itself. The panel is the last place
    // a credential should be readable from.
    out["keyed"] = alphaKey.length() > 0;
    out["reporting"] = report.valid && (millis() - report.fetchedAt) <= REPORT_STALE_MS;
    reply(out, cmd);
    return;
  }

  replyError("unknown cmd", cmd);
}

static void pumpSerial() {
  static String buffer;
  while (Serial.available()) {
    const char c = (char)Serial.read();
    if (c == '\n') {
      String line = buffer;
      buffer = "";
      line.trim();
      if (line.length()) handleCommand(line);
    } else if (c != '\r') {
      // A runaway sender must not be able to grow this without bound.
      if (buffer.length() < 1024) buffer += c;
    }
  }
}

// ----------------------------------------------------------------------- main

void setup() {
  Serial.begin(115200);
  displayInit();
  loadSettings();
  if (networkCount) joinBest();
  drawReport();
}

void loop() {
  pumpSerial();

  if (WiFi.status() != WL_CONNECTED && networkCount &&
      millis() - lastWifiAttempt > WIFI_RETRY_MS) {
    lastWifiAttempt = millis();
    // Re-scan every time rather than retrying the last one: the reason it is
    // disconnected is often that the machine moved, and the network that works
    // now is a different one.
    joinBest();
    drawReport();
  }

  if (millis() - lastPoll > POLL_INTERVAL_MS) {
    lastPoll = millis();
    pollAlpha();
    drawReport();
  }

  delay(20);
}
