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
//   {"cmd":"alpha","host":"http://100.x.y.z:8787","key":"alpha_key_..."}
//                                                  -> {"ok":true}
//   {"cmd":"status"}                               -> {"ok":true,"ssid":...}
//
// Every reply carries `ok` or `error`, because that is what the handler waits
// for before it stops reading. A board that answers nothing looks identical to
// one that is not there, so silence is the one thing this must not do.
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
static String alphaKey;

static uint32_t lastPoll = 0;
static uint32_t lastWifiAttempt = 0;

// The last thing we successfully read, so the screen keeps showing the previous
// report while a poll is in flight or failing, rather than blanking. A display
// that goes empty when the network hiccups reads as "everything is down".
struct Report {
  bool     valid        = false;
  uint32_t agents       = 0;
  uint32_t agentsOnline = 0;
  uint32_t queued       = 0;
  uint32_t running      = 0;
  uint32_t completed    = 0;
  uint32_t failed       = 0;
  String   error;
  uint32_t fetchedAt    = 0;
};

static Report report;

// ---------------------------------------------------------------- persistence

static void loadSettings() {
  prefs.begin("alpha", true);
  wifiSsid     = prefs.getString("ssid", "");
  wifiPassword = prefs.getString("pass", "");
  alphaHost    = prefs.getString("host", "");
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

static void saveAlpha(const String& host, const String& key) {
  prefs.begin("alpha", false);
  prefs.putString("host", host);
  prefs.putString("key", key);
  prefs.end();
  alphaHost = host;
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

// Reads GET /stats off the coordinator. That endpoint is the one that already
// summarises the queue and the registry, so the panel does no arithmetic of its
// own — whatever the host calls "running" is what the screen says.
static void pollAlpha() {
  report.error = "";

  if (WiFi.status() != WL_CONNECTED) { report.error = "no wifi"; return; }
  if (alphaHost.length() == 0)       { report.error = "no host"; return; }

  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setConnectTimeout(HTTP_TIMEOUT_MS);

  String url = alphaHost + "/stats";
  if (!http.begin(url)) { report.error = "bad url"; return; }
  if (alphaKey.length()) http.addHeader("Authorization", "Bearer " + alphaKey);

  const int status = http.GET();
  if (status != 200) {
    // 401 is the one worth naming: it means the panel reached the coordinator
    // and was turned away, which is a different job from "the host is down".
    report.error = (status == 401 || status == 403) ? "unauthorized" : ("http " + String(status));
    http.end();
    return;
  }

  JsonDocument doc;
  const DeserializationError err = deserializeJson(doc, http.getStream());
  http.end();
  if (err) { report.error = "bad json"; return; }

  report.agents       = doc["agents"]["total"]     | doc["agents"]     | 0;
  report.agentsOnline = doc["agents"]["online"]    | report.agents;
  report.queued       = doc["tasks"]["queued"]     | doc["queued"]     | 0;
  report.running      = doc["tasks"]["running"]    | doc["running"]    | 0;
  report.completed    = doc["tasks"]["completed"]  | doc["completed"]  | 0;
  report.failed       = doc["tasks"]["failed"]     | doc["failed"]     | 0;
  report.valid        = true;
  report.fetchedAt    = millis();
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
    displayLine("agents",  String(report.agentsOnline) + " / " + String(report.agents),
                report.agentsOnline > 0 ? DISPLAY_OK : DISPLAY_BAD);
    displayLine("queued",  String(report.queued),    DISPLAY_NORMAL);
    displayLine("running", String(report.running),   DISPLAY_NORMAL);
    displayLine("done",    String(report.completed), DISPLAY_MUTED);
    displayLine("failed",  String(report.failed),    report.failed ? DISPLAY_BAD : DISPLAY_MUTED);
  }

  // Age rather than a clock: the panel has no RTC, and "14s ago" answers the
  // question a wall-clock time on a frozen screen cannot — is this still live?
  if (report.valid) {
    displayFooter(String((millis() - report.fetchedAt) / 1000) + "s ago");
  } else {
    displayFooter("");
  }

  displayEnd();
}

// --------------------------------------------------------------- provisioning

static void reply(const JsonDocument& doc) {
  serializeJson(doc, Serial);
  Serial.println();
  Serial.flush();
}

static void replyError(const char* message) {
  JsonDocument doc;
  doc["error"] = message;
  reply(doc);
}

static void handleCommand(const String& line) {
  JsonDocument in;
  if (deserializeJson(in, line)) { replyError("bad json"); return; }

  const char* cmd = in["cmd"] | "";

  if (strcmp(cmd, "wifi") == 0) {
    const char* ssid = in["ssid"] | "";
    if (strlen(ssid) == 0) { replyError("ssid required"); return; }
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
    reply(out);
    return;
  }

  if (strcmp(cmd, "alpha") == 0) {
    const char* host = in["host"] | "";
    if (strlen(host) == 0) { replyError("host required"); return; }
    saveAlpha(String(host), String(in["key"] | ""));
    JsonDocument out;
    out["ok"] = true;
    out["host"] = alphaHost;
    reply(out);
    return;
  }

  if (strcmp(cmd, "status") == 0) {
    JsonDocument out;
    out["ok"] = true;
    out["ssid"] = wifiSsid;
    out["connected"] = WiFi.status() == WL_CONNECTED;
    if (WiFi.status() == WL_CONNECTED) out["ip"] = WiFi.localIP().toString();
    out["host"] = alphaHost;
    // Whether a key is set, never the key itself. The panel is the last place
    // a credential should be readable from.
    out["keyed"] = alphaKey.length() > 0;
    reply(out);
    return;
  }

  replyError("unknown cmd");
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
