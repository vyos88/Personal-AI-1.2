// crowpanel.ino — the CrowPanel shows a live alpha-tunnel report.
//
// Two jobs, and they are deliberately separate:
//
//   1. Take credentials over the serial line and keep them in NVS. The panel is
//      provisioned by the `alpha.panel` handler sending one JSON line down USB
//      — it is never reflashed to change networks. That is why the WiFi
//      password is not in this file and must never be put in it: firmware is
//      built, cached and copied around, and a secret compiled into it leaks
//      everywhere the binary goes.
//
//   2. Poll the coordinator and draw what it says. Read-only. The panel asks
//      the host questions and renders answers; it queues nothing, claims
//      nothing, and holds no lease. A display that could dispatch work would be
//      a second coordinator with a screen.
//
// Provisioning protocol — newline-delimited JSON in, newline-delimited JSON out:
//
//   {"cmd":"wifi","ssid":"...","password":"..."}   -> {"ok":true,"ip":"..."}
//   {"cmd":"alpha","host":"http://...","host2":"http://...","key":"alpha_key_..."}
//                                                  -> {"ok":true}
//
//      host2 is the standby: the laptop that runs Alpha while the host is off.
//      The panel reads the primary and falls back, so the screen keeps showing
//      live numbers through a failover instead of going dark.
//   {"cmd":"status"}                               -> {"ok":true,"ssid":...}
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

// How often to ask the coordinator for a fresh report. The host holds this in
// memory and answers instantly, but a panel that polled every second would add
// a request per second to a box whose job is dispatching work.
static const uint32_t POLL_INTERVAL_MS = 5000;
static const uint32_t WIFI_RETRY_MS    = 15000;
static const uint16_t HTTP_TIMEOUT_MS  = 4000;

// NVS namespace. Credentials live here and nowhere else on the device.
static Preferences prefs;

static String wifiSsid;
static String wifiPassword;
static String alphaHost;
static String alphaStandby;   // where Alpha runs while the host is off
static String alphaKey;
static bool   onStandby = false;

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

static void loadSettings() {
  prefs.begin("alpha", true);
  wifiSsid     = prefs.getString("ssid", "");
  wifiPassword = prefs.getString("pass", "");
  alphaHost    = prefs.getString("host", "");
  alphaStandby = prefs.getString("host2", "");
  alphaKey     = prefs.getString("key", "");
  prefs.end();
}

static void saveWifi(const String& ssid, const String& password) {
  prefs.begin("alpha", false);
  prefs.putString("ssid", ssid);
  prefs.putString("pass", password);
  prefs.end();
  wifiSsid = ssid;
  wifiPassword = password;
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

// Blocking, but only for as long as a join reasonably takes. The panel has
// nothing else to do until it is on the network, and the serial reader is
// polled again the moment this returns either way.
static bool joinWifi(uint32_t timeoutMs) {
  if (wifiSsid.length() == 0) return false;

  WiFi.mode(WIFI_STA);
  WiFi.begin(wifiSsid.c_str(), wifiPassword.length() ? wifiPassword.c_str() : nullptr);

  const uint32_t started = millis();
  while (millis() - started < timeoutMs) {
    if (WiFi.status() == WL_CONNECTED) return true;
    delay(200);
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

static void drawReport() {
  displayBegin();

  displayTitle("alpha-tunnel");

  if (WiFi.status() == WL_CONNECTED) {
    displayLine("wifi", wifiSsid + "  " + WiFi.localIP().toString(), DISPLAY_OK);
    displayLine("rssi", String(WiFi.RSSI()) + " dBm", DISPLAY_MUTED);
  } else {
    displayLine("wifi", wifiSsid.length() ? "joining " + wifiSsid : "not provisioned", DISPLAY_BAD);
  }

  if (report.error.length()) {
    displayLine("host", report.error, DISPLAY_BAD);
  } else if (!report.valid) {
    displayLine("host", "waiting", DISPLAY_MUTED);
  } else {
    displayLine("agents",  String(report.agents),
                report.agents > 0 ? DISPLAY_OK : DISPLAY_BAD);
    // Queued work waiting on RAM rather than on a free machine is worth saying
    // out loud: it is the one backlog that adding a machine does not clear.
    displayLine("queued",  report.blocked ? String(report.queued) + "  (" + String(report.blocked) + " on ram)"
                                          : String(report.queued), DISPLAY_NORMAL);
    displayLine("running", String(report.running),   DISPLAY_NORMAL);
    displayLine("done",    String(report.completed), DISPLAY_MUTED);
    displayLine("failed",  String(report.failed),    report.failed ? DISPLAY_BAD : DISPLAY_MUTED);
  }

  // Age rather than a clock: the panel has no RTC, and "14s ago" answers the
  // question a wall-clock time on a frozen screen cannot — is this still live?
  if (report.valid) {
    const String age = String((millis() - report.fetchedAt) / 1000) + "s ago";
    // Reading the standby is not an error, but it is not the normal state
    // either, and a screen that does not say so hides a host that is off.
    const String where = onStandby ? "  [standby]" : "";
    displayFooter((report.version.length() ? "alpha " + report.version + "  " + age : age) + where);
  } else {
    displayFooter("");
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

static void handleCommand(const String& line) {
  JsonDocument in;
  if (deserializeJson(in, line)) { replyError("bad json", ""); return; }

  const char* cmd = in["cmd"] | "";

  if (strcmp(cmd, "wifi") == 0) {
    const char* ssid = in["ssid"] | "";
    if (strlen(ssid) == 0) { replyError("ssid required", cmd); return; }
    saveWifi(String(ssid), String(in["password"] | ""));

    // Join straight away and report the outcome, so the task that sent the
    // credentials learns whether they actually work instead of only that they
    // were stored. A password accepted and silently wrong is the failure this
    // whole flow exists to avoid.
    const bool joined = joinWifi(20000);
    JsonDocument out;
    out["ok"] = joined;
    out["ssid"] = wifiSsid;
    if (joined) out["ip"] = WiFi.localIP().toString();
    else        out["error"] = "join failed";
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

  if (strcmp(cmd, "status") == 0) {
    JsonDocument out;
    out["ok"] = true;
    out["ssid"] = wifiSsid;
    out["connected"] = WiFi.status() == WL_CONNECTED;
    if (WiFi.status() == WL_CONNECTED) out["ip"] = WiFi.localIP().toString();
    out["host"] = alphaHost;
    out["host2"] = alphaStandby;
    // Whether a key is set, never the key itself. The panel is the last place
    // a credential should be readable from.
    out["keyed"] = alphaKey.length() > 0;
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
      if (buffer.length() < 512) buffer += c;
    }
  }
}

// ----------------------------------------------------------------------- main

void setup() {
  Serial.begin(115200);
  displayInit();
  loadSettings();
  if (wifiSsid.length()) joinWifi(15000);
  drawReport();
}

void loop() {
  pumpSerial();

  if (WiFi.status() != WL_CONNECTED && wifiSsid.length() &&
      millis() - lastWifiAttempt > WIFI_RETRY_MS) {
    lastWifiAttempt = millis();
    joinWifi(8000);
  }

  if (millis() - lastPoll > POLL_INTERVAL_MS) {
    lastPoll = millis();
    pollAlpha();
    drawReport();
  }

  delay(20);
}
