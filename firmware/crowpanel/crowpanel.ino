// crowpanel.ino — the CrowPanel shows a live alpha-tunnel report, a page at a time.
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
// **This is not Alpha's deck firmware.** Alpha has its own CrowPanel sketch
// (`hardware/examples/crowpanel_alpha_*` in that repository) which holds no
// credential, polls `/panel/crowpanel/public-state` on Alpha's backend and takes
// bare-word serial commands (`STATUS`, `WIFI "ssid" pass`, `ALPHA http://...`).
// One board runs one of the two. They are told apart on the wire: this one
// answers newline-delimited JSON, and the handler says which it found rather
// than timing out and blaming the cable.
//
// It knows more than one of each thing, because everything it depends on is
// something that goes away:
//
//   - **Several networks.** A laptop moves between the house WiFi and a
//     hotspot; a panel that knows one of them is dark for the other. It keeps
//     up to PANEL_MAX_NETWORKS and picks by signal, not by the order they were
//     given: the strongest one the radio can actually see wins.
//   - **Two coordinators.** `host` is the usual one and `host2` the standby
//     that runs while the host is off. The primary is tried first on every
//     poll, so coming home needs no signal to arrive and nothing to notice.
//
// **Pages.** One screen cannot hold a fleet. Five rotate, every
// PAGE_INTERVAL_MS, and each is sourced from the endpoint that actually owns
// its numbers rather than from arithmetic done here:
//
//   fleet     /stats            agents, queued, running, done, failed
//   machines  /agents           a row per machine: load, free RAM, in flight
//   work      /stats            what is in flight, and which types are covered
//   receipts  /receipts/summary what the fleet has actually produced
//   panel     (local)           this panel: network, signal, which coordinator
//
// Each page's data is fetched when that page comes round, not all of it every
// five seconds: a wall display must not be the reason a coordinator is busy.
// The `panel` page needs no network at all, which is the point — it is the page
// that still works when nothing else does.
//
// Provisioning protocol — newline-delimited JSON in, newline-delimited JSON out:
//
//   {"cmd":"wifi","ssid":"...","password":"..."}
//   {"cmd":"wifi","networks":[{"ssid":"a","password":"1"},{"ssid":"b"}]}
//                        -> {"ok":true,"cmd":"wifi","ssid":"a","ip":"...","rssi":-54}
//   {"cmd":"alpha","host":"http://...","host2":"http://...","key":"alpha_key_..."}
//                        -> {"ok":true,"cmd":"alpha","host":"...","host2":"..."}
//   {"cmd":"scan"}       -> {"ok":true,"cmd":"scan","networks":[{"ssid":"a","rssi":-54}]}
//   {"cmd":"page","page":"machines"[,"hold":true]}
//                        -> {"ok":true,"cmd":"page","page":"machines","hold":true}
//   {"cmd":"status"}     -> {"ok":true,"cmd":"status","ssid":"a","page":"fleet", ...}
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

// Printed on the panel page and reported by `status`, so "which firmware is on
// that board" is answerable from the wire instead of from memory.
static const char* PANEL_FIRMWARE = "panel-3";

// How often to ask the coordinator for a fresh report. The host holds this in
// memory and answers instantly, but a panel polling every second would add a
// request per second to a box whose job is dispatching work.
static const uint32_t POLL_INTERVAL_MS = 5000;
// How long each page stays up, and how long a report stays worth showing. Past
// the second one the numbers are still drawn but marked stale: a frozen screen
// that looks live is the failure a status display must not have.
static const uint32_t PAGE_INTERVAL_MS = 8000;
static const uint32_t REPORT_STALE_MS  = 20000;
static const uint32_t WIFI_RETRY_MS    = 15000;
static const uint16_t HTTP_TIMEOUT_MS  = 4000;
static const uint32_t JOIN_TIMEOUT_MS  = 12000;

// Four is a house, a hotspot, a neighbour's guest network and one spare. More
// would not fit the join budget: every one that is tried and fails is seconds
// the screen is dark.
static const uint8_t PANEL_MAX_NETWORKS = 4;
// What fits on the small panels, and what a filtered parse can hold without
// fragmenting the heap. A fleet bigger than this shows the first rows and says
// how many it is not showing, rather than drawing off the bottom in silence.
static const uint8_t PANEL_MAX_MACHINES = 6;
static const uint8_t PANEL_MAX_TYPES    = 6;

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
static uint32_t lastPageTurn = 0;
static uint32_t pollFailures = 0;   // since the last success, for the panel page

// ------------------------------------------------------------------- the pages

enum Page : uint8_t {
  PAGE_FLEET = 0,
  PAGE_MACHINES,
  PAGE_WORK,
  PAGE_RECEIPTS,
  PAGE_PANEL,
  PAGE_COUNT,
};

static const char* PAGE_NAMES[PAGE_COUNT] = { "fleet", "machines", "work", "receipts", "panel" };

static uint8_t page = PAGE_FLEET;
// A page an operator asked for stays up: somebody standing in front of the
// panel reading the machines list should not have it slide away mid-sentence.
static bool pageHeld = false;

// ------------------------------------------------------------------ what we know

// The last thing each page successfully read, so a screen keeps showing the
// previous answer while a fetch is in flight or failing rather than blanking. A
// display that goes empty when the network hiccups reads as "everything is
// down".
struct Fleet {
  bool     valid     = false;
  uint32_t agents    = 0;   // attached agents; the host prunes stale ones itself
  uint32_t queued    = 0;
  uint32_t running   = 0;   // leased: held by an agent right now
  uint32_t completed = 0;
  uint32_t failed    = 0;
  uint32_t blocked   = 0;   // queued and waiting on memory, not on a machine
  uint32_t offeredMB = 0;
  // From /stats's load summary: how many machines are reporting load at all,
  // the busiest and idlest of them, and what they are holding.
  uint32_t reporting = 0;
  uint32_t unknown   = 0;
  float    busiest   = -1;
  float    idlest    = -1;
  uint32_t inFlight  = 0;
  String   types[PANEL_MAX_TYPES];
  uint8_t  typeCount = 0;
  String   version;
  String   error;
  uint32_t fetchedAt = 0;
};

struct Machine {
  String   name;
  float    load = -1;        // -1: not reporting, which is never read as idle
  uint32_t freeMB = 0;
  uint32_t inFlight = 0;
  bool     stale = false;
  bool     drifted = false;
};

struct Machines {
  bool    valid = false;
  Machine rows[PANEL_MAX_MACHINES];
  uint8_t count = 0;
  uint8_t total = 0;         // what the host said, which may exceed `count`
  String  error;
  uint32_t fetchedAt = 0;
};

struct Receipts {
  bool     valid = false;
  bool     allowed = true;   // false when the panel's key lacks tasks:read
  uint32_t total = 0;
  String   types[PANEL_MAX_TYPES];
  uint32_t counts[PANEL_MAX_TYPES] = { 0 };
  uint8_t  typeCount = 0;
  uint32_t outputs = 0;
  uint64_t bytes = 0;
  uint32_t succeeded = 0;
  uint32_t failed = 0;
  String   error;
  uint32_t fetchedAt = 0;
};

static Fleet fleet;
static Machines machines;
static Receipts receipts;

// ---------------------------------------------------------------- persistence

// Networks are stored as one JSON array under "nets". The alternative — ssid0,
// pass0, ssid1... — needs a separate count key that can disagree with the keys
// it counts, and a half-written set of credentials is a panel that joins
// nothing.
static void loadSettings() {
  prefs.begin("alpha", true);
  const String stored = prefs.getString("nets", "");
  // Migration: a panel provisioned by an older firmware has one network under
  // the old keys, and reflashing must not cost it the credentials it has.
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

// Where a GET ended up, so a caller can say both what went wrong and which
// coordinator it was talking to.
struct Fetch {
  bool   ok = false;
  int    status = 0;
  String error;
};

/**
 * One GET against one coordinator, parsed through a filter.
 *
 * The filter is not an optimisation. `/agents` carries every field the host
 * knows about every machine, and an ESP32 parsing all of it for the four
 * numbers a row needs is how a panel runs out of heap on the day a fourth
 * laptop joins.
 */
static Fetch getJson(const String& base, const char* path, JsonDocument& doc, JsonDocument& filter) {
  Fetch result;
  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setConnectTimeout(HTTP_TIMEOUT_MS);

  if (!http.begin(base + path)) {
    result.error = "bad url";
    return result;
  }
  if (alphaKey.length()) http.addHeader("Authorization", "Bearer " + alphaKey);

  result.status = http.GET();
  if (result.status != 200) {
    // 401 and 403 are worth telling apart from "the host is down": the panel
    // reached the coordinator and was turned away, which is a credential
    // problem and not a network one.
    result.error = result.status == 401 ? "unauthorized"
                   : result.status == 403 ? "forbidden"
                                          : ("http " + String(result.status));
    http.end();
    return result;
  }

  const DeserializationError err =
      deserializeJson(doc, http.getStream(), DeserializationOption::Filter(filter));
  http.end();
  if (err) {
    result.error = "bad json";
    return result;
  }
  result.ok = true;
  return result;
}

/**
 * The same GET, primary first and then the standby.
 *
 * Always starting at the primary is what brings the panel home when the host
 * comes back: there is no separate "the host is up again" signal to miss, and
 * the cost of being wrong is one failed request per fetch.
 */
static Fetch fetchFrom(const char* path, JsonDocument& doc, JsonDocument& filter) {
  Fetch result;
  result.error = "no host";
  if (WiFi.status() != WL_CONNECTED) {
    result.error = "no wifi";
    return result;
  }
  if (alphaHost.length() == 0) return result;

  result = getJson(alphaHost, path, doc, filter);
  if (result.ok) {
    onStandby = false;
    return result;
  }
  // A coordinator that answered and refused is not failed over from: the
  // standby holds the same credential and will say the same thing.
  if (result.status == 401 || result.status == 403) return result;

  if (alphaStandby.length()) {
    const String primaryError = result.error;
    Fetch second = getJson(alphaStandby, path, doc, filter);
    if (second.ok) {
      onStandby = true;
      return second;
    }
    // Name the primary's failure: it is the one that explains why the fleet
    // would be on a laptop at all.
    second.error = primaryError;
    return second;
  }
  return result;
}

/** Page 1 and 3: the fleet, and what it is doing. */
static void fetchFleet() {
  JsonDocument filter;
  filter["version"] = true;
  filter["agents"] = true;
  filter["capabilities"] = true;
  filter["queue"]["byStatus"] = true;
  filter["memory"] = true;
  filter["load"] = true;

  JsonDocument doc;
  const Fetch got = fetchFrom("/stats", doc, filter);
  if (!got.ok) {
    fleet.error = got.error;
    pollFailures++;
    return;
  }

  // Read with the host's own names, from src/host/server.js:
  //
  //   { version, agents: <count>, capabilities: [...],
  //     queue:  { total, pending, waiters, byStatus: { queued, leased, ... } },
  //     memory: { offeredBytes, blockedTasks },
  //     load:   { reporting, unknown, busiest, idlest, tasksInFlight } }
  //
  // Guessing at plausible-looking names instead is how a panel ends up showing
  // a confident row of zeroes, which reads as "the fleet is idle" rather than
  // as "this display is reading the wrong keys".
  JsonObject byStatus = doc["queue"]["byStatus"];
  JsonObject load = doc["load"];
  fleet.version   = doc["version"]            | "";
  fleet.agents    = doc["agents"]             | 0;
  fleet.queued    = byStatus["queued"]        | 0;
  fleet.running   = byStatus["leased"]        | 0;
  fleet.completed = byStatus["succeeded"]     | 0;
  fleet.failed    = byStatus["failed"]        | 0;
  fleet.blocked   = doc["memory"]["blockedTasks"] | 0;
  fleet.offeredMB = (uint32_t)((doc["memory"]["offeredBytes"] | 0ULL) / (1024ULL * 1024ULL));
  fleet.reporting = load["reporting"]         | 0;
  fleet.unknown   = load["unknown"]           | 0;
  fleet.busiest   = load["busiest"].isNull() ? -1 : (float)(load["busiest"] | 0.0);
  fleet.idlest    = load["idlest"].isNull() ? -1 : (float)(load["idlest"] | 0.0);
  fleet.inFlight  = load["tasksInFlight"]     | 0;

  fleet.typeCount = 0;
  for (JsonVariant entry : doc["capabilities"].as<JsonArray>()) {
    if (fleet.typeCount >= PANEL_MAX_TYPES) break;
    fleet.types[fleet.typeCount++] = String(entry.as<const char*>() ? entry.as<const char*>() : "");
  }

  fleet.valid = true;
  fleet.error = "";
  fleet.fetchedAt = millis();
  pollFailures = 0;
}

/** Page 2: a row per machine, which is the page people actually stand and read. */
static void fetchMachines() {
  JsonDocument filter;
  JsonObject row = filter["agents"].add<JsonObject>();
  row["name"] = true;
  row["loadFactor"] = true;
  row["availableBytes"] = true;
  row["inFlight"] = true;
  row["stale"] = true;
  row["version"] = true;
  filter["hostVersion"] = true;

  JsonDocument doc;
  const Fetch got = fetchFrom("/agents", doc, filter);
  if (!got.ok) {
    machines.error = got.error;
    return;
  }

  const char* hostVersion = doc["hostVersion"] | "";
  machines.count = 0;
  machines.total = 0;
  for (JsonObject entry : doc["agents"].as<JsonArray>()) {
    machines.total++;
    if (machines.count >= PANEL_MAX_MACHINES) continue;
    Machine& machine = machines.rows[machines.count];
    machine.name = String(entry["name"] | "?");
    machine.load = entry["loadFactor"].isNull() ? -1 : (float)(entry["loadFactor"] | 0.0);
    machine.freeMB = (uint32_t)((entry["availableBytes"] | 0ULL) / (1024ULL * 1024ULL));
    machine.inFlight = entry["inFlight"] | 0;
    machine.stale = entry["stale"] | false;
    const char* version = entry["version"] | "";
    machine.drifted = strlen(version) && strlen(hostVersion) && strcmp(version, hostVersion) != 0;
    machines.count++;
  }
  machines.valid = true;
  machines.error = "";
  machines.fetchedAt = millis();
}

/** Page 4: what the fleet actually produced, rather than what it was asked for. */
static void fetchReceipts() {
  JsonDocument filter;
  filter["total"] = true;
  filter["byType"] = true;
  filter["byStatus"] = true;
  filter["outputs"] = true;
  filter["bytes"] = true;

  JsonDocument doc;
  const Fetch got = fetchFrom("/receipts/summary", doc, filter);
  if (!got.ok) {
    // The panel's key is read-only, but `tasks:read` and `agents:read` are two
    // scopes: a panel provisioned with only the second cannot see receipts, and
    // saying so is more use than an http code nobody can act on.
    receipts.allowed = got.status != 403;
    receipts.error = got.error;
    return;
  }

  receipts.total = doc["total"] | 0;
  receipts.outputs = doc["outputs"] | 0;
  receipts.bytes = doc["bytes"] | 0ULL;
  receipts.succeeded = doc["byStatus"]["succeeded"] | 0;
  receipts.failed = doc["byStatus"]["failed"] | 0;

  receipts.typeCount = 0;
  for (JsonPair entry : doc["byType"].as<JsonObject>()) {
    if (receipts.typeCount >= PANEL_MAX_TYPES) break;
    receipts.types[receipts.typeCount] = String(entry.key().c_str());
    receipts.counts[receipts.typeCount] = entry.value() | 0;
    receipts.typeCount++;
  }

  receipts.allowed = true;
  receipts.valid = true;
  receipts.error = "";
  receipts.fetchedAt = millis();
}

/** Whatever the page now on screen needs, and nothing else. */
static void fetchForPage(uint8_t which) {
  switch (which) {
    case PAGE_MACHINES: fetchMachines(); break;
    case PAGE_RECEIPTS: fetchReceipts(); break;
    // The panel page is local, and fleet/work both come off /stats, which is
    // polled on its own clock for the header either way.
    default: break;
  }
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

static String humanBytes(uint64_t bytes) {
  if (bytes >= 1024ULL * 1024 * 1024) return String((float)bytes / (1024.0 * 1024 * 1024), 1) + " GB";
  if (bytes >= 1024ULL * 1024) return String((uint32_t)(bytes / (1024ULL * 1024))) + " MB";
  if (bytes >= 1024ULL) return String((uint32_t)(bytes / 1024ULL)) + " kB";
  return String((uint32_t)bytes) + " B";
}

static String loadWord(float factor) {
  // Unknown load is never drawn as idle: Windows has no load average, and a
  // blank reading made to look like zero is how the quietest *reporter* beats
  // the quietest *machine*.
  if (factor < 0) return "load ?";
  return String((int)(factor * 100)) + "%";
}

static bool fleetStale() {
  return fleet.valid && (millis() - fleet.fetchedAt) > REPORT_STALE_MS;
}

static void drawFleetPage() {
  const bool stale = fleetStale();
  if (fleet.error.length()) displayLine("host", fleet.error, DISPLAY_BAD);
  if (!fleet.valid) {
    if (!fleet.error.length()) displayLine("host", "waiting", DISPLAY_MUTED);
    return;
  }
  const DisplayTone tone = stale ? DISPLAY_MUTED : DISPLAY_NORMAL;
  displayLine("agents", String(fleet.agents),
              stale ? DISPLAY_MUTED : (fleet.agents > 0 ? DISPLAY_OK : DISPLAY_BAD));
  // Queued work waiting on RAM rather than on a free machine is worth saying
  // out loud: it is the one backlog that adding a machine does not clear.
  displayLine("queued", fleet.blocked ? String(fleet.queued) + "  (" + String(fleet.blocked) + " on ram)"
                                      : String(fleet.queued), tone);
  displayLine("running", String(fleet.running), tone);
  displayLine("done", String(fleet.completed), DISPLAY_MUTED);
  displayLine("failed", String(fleet.failed), fleet.failed && !stale ? DISPLAY_BAD : DISPLAY_MUTED);
}

static void drawMachinesPage() {
  if (!machines.valid) {
    displayLine("machines", machines.error.length() ? machines.error : "waiting",
                machines.error.length() ? DISPLAY_BAD : DISPLAY_MUTED);
    return;
  }
  if (machines.count == 0) {
    // An empty list is a real answer and a bad one: nothing is lending.
    displayLine("machines", "none attached", DISPLAY_BAD);
    return;
  }
  for (uint8_t i = 0; i < machines.count; i++) {
    const Machine& machine = machines.rows[i];
    String value = loadWord(machine.load) + "  " + String(machine.freeMB) + "MB";
    if (machine.inFlight) value += "  x" + String(machine.inFlight);
    if (machine.drifted) value += "  !ver";
    displayLine(machine.name, value, machine.stale ? DISPLAY_BAD : DISPLAY_NORMAL);
  }
  if (machines.total > machines.count) {
    displayLine("", "+" + String(machines.total - machines.count) + " more", DISPLAY_MUTED);
  }
}

static void drawWorkPage() {
  if (!fleet.valid) {
    displayLine("work", fleet.error.length() ? fleet.error : "waiting",
                fleet.error.length() ? DISPLAY_BAD : DISPLAY_MUTED);
    return;
  }
  displayLine("in flight", String(fleet.inFlight), fleet.inFlight ? DISPLAY_OK : DISPLAY_MUTED);
  displayLine("busiest", fleet.busiest < 0 ? "?" : loadWord(fleet.busiest), DISPLAY_NORMAL);
  displayLine("idlest", fleet.idlest < 0 ? "?" : loadWord(fleet.idlest), DISPLAY_NORMAL);
  // Machines whose load nobody knows: a fleet where this is most of them is
  // being placed on guesses.
  displayLine("load seen", String(fleet.reporting) + " of " + String(fleet.reporting + fleet.unknown),
              fleet.unknown ? DISPLAY_MUTED : DISPLAY_OK);
  displayLine("offered", String(fleet.offeredMB) + " MB", DISPLAY_MUTED);
  if (fleet.typeCount == 0) {
    // No capability covered at all means every queued task is waiting for a
    // machine that never arrives — the failure this page exists to show.
    displayLine("types", "none covered", DISPLAY_BAD);
  } else {
    String types = fleet.types[0];
    for (uint8_t i = 1; i < fleet.typeCount; i++) types += " " + fleet.types[i];
    displayLine("types", types, DISPLAY_MUTED);
  }
}

static void drawReceiptsPage() {
  if (!receipts.allowed) {
    displayLine("receipts", "key needs tasks:read", DISPLAY_BAD);
    return;
  }
  if (!receipts.valid) {
    displayLine("receipts", receipts.error.length() ? receipts.error : "waiting",
                receipts.error.length() ? DISPLAY_BAD : DISPLAY_MUTED);
    return;
  }
  displayLine("receipts", String(receipts.total), receipts.total ? DISPLAY_OK : DISPLAY_MUTED);
  displayLine("ok / bad", String(receipts.succeeded) + " / " + String(receipts.failed),
              receipts.failed ? DISPLAY_BAD : DISPLAY_MUTED);
  displayLine("outputs", String(receipts.outputs) + "  " + humanBytes(receipts.bytes), DISPLAY_NORMAL);
  for (uint8_t i = 0; i < receipts.typeCount && i < 3; i++) {
    displayLine(receipts.types[i], String(receipts.counts[i]), DISPLAY_MUTED);
  }
}

static void drawPanelPage() {
  // The page that still works when nothing else does: everything here is read
  // off this board, so it answers "is it the panel or the fleet?" with no
  // network at all.
  if (WiFi.status() == WL_CONNECTED) {
    displayLine("wifi", joinedSsid, DISPLAY_OK);
    displayLine("ip", WiFi.localIP().toString(), DISPLAY_NORMAL);
    displayLine("signal", String(signalWord(WiFi.RSSI())) + "  " + String(WiFi.RSSI()) + " dBm",
                WiFi.RSSI() >= -75 ? DISPLAY_MUTED : DISPLAY_BAD);
  } else {
    displayLine("wifi", networkCount ? "joining" : "not provisioned", DISPLAY_BAD);
    String names = networkCount ? networks[0].ssid : String("");
    for (uint8_t i = 1; i < networkCount; i++) names += ", " + networks[i].ssid;
    if (names.length()) displayLine("known", names, DISPLAY_MUTED);
  }
  const String target = onStandby ? alphaStandby : alphaHost;
  displayLine("alpha", target.length() ? target : "no host", target.length() ? DISPLAY_NORMAL : DISPLAY_BAD);
  if (onStandby) displayLine("via", "standby", DISPLAY_BAD);
  if (pollFailures) displayLine("misses", String(pollFailures), DISPLAY_BAD);
  displayLine("firmware", String(PANEL_FIRMWARE) + "  up " + String(millis() / 60000) + "m", DISPLAY_MUTED);
}

static void draw() {
  displayBegin();
  displayTitle(String("alpha  ") + PAGE_NAMES[page]);

  switch (page) {
    case PAGE_MACHINES: drawMachinesPage(); break;
    case PAGE_WORK:     drawWorkPage(); break;
    case PAGE_RECEIPTS: drawReceiptsPage(); break;
    case PAGE_PANEL:    drawPanelPage(); break;
    default:            drawFleetPage(); break;
  }

  // Which page of how many, and the age of the thing on screen. Age rather
  // than a clock: the panel has no RTC, and "14s ago" answers the question a
  // wall-clock time on a frozen screen cannot — is this still live?
  String footer = String(page + 1) + "/" + String((int)PAGE_COUNT);
  if (pageHeld) footer += " held";
  if (page != PAGE_PANEL && fleet.valid) {
    footer += "  " + String((millis() - fleet.fetchedAt) / 1000) + "s ago";
    if (fleetStale()) footer += " [stale]";
  }
  if (onStandby) footer += "  [standby]";
  if (page == PAGE_PANEL && fleet.version.length()) footer += "  alpha " + fleet.version;
  displayFooter(footer);

  displayEnd();
}

static void showPage(uint8_t which) {
  page = which % PAGE_COUNT;
  lastPageTurn = millis();
  fetchForPage(page);
  draw();
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
    // A new coordinator means every page's data is about the old one.
    fleet.valid = machines.valid = receipts.valid = false;
    receipts.allowed = true;
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

  if (strcmp(cmd, "page") == 0) {
    const char* wanted = in["page"] | "";
    int8_t found = -1;
    for (uint8_t i = 0; i < PAGE_COUNT; i++) {
      if (strcmp(wanted, PAGE_NAMES[i]) == 0) found = (int8_t)i;
    }
    // "next" is what a person at a keyboard actually wants, and what a wall
    // button would send if this board had one.
    if (found < 0 && strcmp(wanted, "next") == 0) found = (int8_t)((page + 1) % PAGE_COUNT);
    if (found < 0 && strlen(wanted)) {
      replyError("unknown page", cmd);
      return;
    }
    // `hold` with no page name stops the rotation where it is, which is the
    // other half of standing in front of it reading.
    if (in["hold"].is<bool>()) pageHeld = in["hold"].as<bool>();
    if (found >= 0) showPage((uint8_t)found);

    JsonDocument out;
    out["ok"] = true;
    out["page"] = PAGE_NAMES[page];
    out["hold"] = pageHeld;
    JsonArray list = out["pages"].to<JsonArray>();
    for (uint8_t i = 0; i < PAGE_COUNT; i++) list.add(PAGE_NAMES[i]);
    reply(out, cmd);
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
    out["page"] = PAGE_NAMES[page];
    out["hold"] = pageHeld;
    // Whether a key is set, never the key itself. The panel is the last place
    // a credential should be readable from.
    out["keyed"] = alphaKey.length() > 0;
    out["reporting"] = fleet.valid && !fleetStale();
    out["receipts"] = receipts.allowed;
    out["misses"] = pollFailures;
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
  // Start on the panel page: before a coordinator answers, the only true thing
  // this board can say is about itself.
  page = networkCount && alphaHost.length() ? PAGE_FLEET : PAGE_PANEL;
  lastPageTurn = millis();
  draw();
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
    draw();
  }

  if (millis() - lastPoll > POLL_INTERVAL_MS) {
    lastPoll = millis();
    fetchFleet();
    // The page on screen may want more than /stats — refresh it on the same
    // beat so a held page does not sit on numbers from when it was opened.
    fetchForPage(page);
    draw();
  }

  if (!pageHeld && millis() - lastPageTurn > PAGE_INTERVAL_MS) {
    showPage((page + 1) % PAGE_COUNT);
  }

  delay(20);
}
