// Wi-Fi with credentials kept in NVS - never in source code or in the firmware build.
//
// Set them once from the ESP Mobile Flash serial monitor:
//   wifi <ssid> <password>        e.g.  wifi "My Network" hunter2
//   wifi                          show status / IP address
//   wifi clear                    forget credentials
//
// Usage: call wifi_setup::begin() in setup() and wifi_setup::loop() in loop().
#pragma once
#include <Preferences.h>
#include <WiFi.h>

namespace wifi_setup {

static void connect() {
  Preferences prefs;
  prefs.begin("wifi", true);
  String ssid = prefs.getString("ssid", "");
  String pass = prefs.getString("pass", "");
  prefs.end();
  if (ssid.isEmpty()) {
    Serial.println("[wifi] no credentials saved. Send: wifi <ssid> <password>");
    return;
  }
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(ssid.c_str(), pass.c_str());
  Serial.printf("[wifi] connecting to \"%s\"...\n", ssid.c_str());
}

// Split `wifi "my ssid" pass word` into ssid and password (quotes optional).
static bool parse_args(String args, String &ssid, String &pass) {
  args.trim();
  if (args.startsWith("\"")) {
    int end = args.indexOf('"', 1);
    if (end < 0) return false;
    ssid = args.substring(1, end);
    pass = args.substring(end + 1);
  } else {
    int sp = args.indexOf(' ');
    ssid = sp < 0 ? args : args.substring(0, sp);
    pass = sp < 0 ? "" : args.substring(sp + 1);
  }
  pass.trim();
  if (pass.startsWith("\"") && pass.endsWith("\"") && pass.length() >= 2) pass = pass.substring(1, pass.length() - 1);
  return !ssid.isEmpty();
}

static void handle_command(String line) {
  line.trim();
  if (line == "wifi") {
    if (WiFi.status() == WL_CONNECTED)
      Serial.printf("[wifi] connected to \"%s\", IP %s\n", WiFi.SSID().c_str(), WiFi.localIP().toString().c_str());
    else
      Serial.println("[wifi] not connected");
  } else if (line == "wifi clear") {
    Preferences prefs;
    prefs.begin("wifi", false);
    prefs.clear();
    prefs.end();
    WiFi.disconnect(true);
    Serial.println("[wifi] credentials cleared");
  } else if (line.startsWith("wifi ")) {
    String ssid, pass;
    if (!parse_args(line.substring(5), ssid, pass)) {
      Serial.println("[wifi] usage: wifi <ssid> <password>");
      return;
    }
    Preferences prefs;
    prefs.begin("wifi", false);
    prefs.putString("ssid", ssid);
    prefs.putString("pass", pass);
    prefs.end();
    Serial.println("[wifi] credentials saved");
    WiFi.disconnect();
    connect();
  }
}

static void begin() { connect(); }

// Call from loop(): handles serial commands and reports connection changes.
static void loop() {
  static String line;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      if (line.startsWith("wifi")) handle_command(line);
      line = "";
    } else if (line.length() < 200) {
      line += c;
    }
  }
  static wl_status_t last = WL_IDLE_STATUS;
  wl_status_t now = WiFi.status();
  if (now != last) {
    if (now == WL_CONNECTED) Serial.printf("[wifi] connected, IP %s\n", WiFi.localIP().toString().c_str());
    else if (last == WL_CONNECTED) Serial.println("[wifi] disconnected");
    last = now;
  }
}

}  // namespace wifi_setup
