#pragma once
//
// display.h — the board-specific half of the panel, kept in one file on purpose.
//
// CrowPanel is a family, not a board: the 2.4"/3.5" units are SPI (ILI9341,
// ST7796), the 5"/7" units are RGB parallel on an ESP32-S3, and they do not
// share a driver. Everything in crowpanel.ino is the same on all of them, so
// the part that is not lives here and nowhere else. Porting to a different
// CrowPanel means editing this file and the FQBN — not the sketch.
//
// Two builds are supported:
//
//   default                     TFT_eSPI, configured through its User_Setup.h
//   -DPANEL_DISPLAY_SERIAL_ONLY  no display at all; the report goes to Serial
//
// The serial-only build is not a toy. It is how you confirm the WiFi
// provisioning, the polling and the report are correct *before* the display
// config is right, which otherwise turns one unknown into two: a blank screen
// cannot tell you whether the panel failed to join the network or the driver is
// wrong. Flash serial-only first, watch a report arrive, then do the display.

#include <Arduino.h>

enum DisplayTone { DISPLAY_NORMAL, DISPLAY_MUTED, DISPLAY_OK, DISPLAY_BAD };

#ifdef PANEL_DISPLAY_SERIAL_ONLY

// ---------------------------------------------------------------- serial only

inline void displayInit() {}
inline void displayBegin() { Serial.println(F("---- alpha-tunnel ----")); }

inline void displayTitle(const String&) {}

inline void displayLine(const String& label, const String& value, DisplayTone tone) {
  Serial.print(label);
  Serial.print(F(": "));
  Serial.print(value);
  if (tone == DISPLAY_BAD) Serial.print(F("   <!>"));
  Serial.println();
}

inline void displayFooter(const String& note) {
  if (note.length()) { Serial.print(F("(")); Serial.print(note); Serial.println(F(")")); }
}

inline void displayEnd() { Serial.println(); }

#else

// -------------------------------------------------------------------- TFT_eSPI
//
// TFT_eSPI is configured at library level (User_Setup.h / User_Setup_Select.h),
// not from here — that is how the library works, and duplicating pin defines in
// the sketch is how the two drift apart and the screen comes up white.

#include <TFT_eSPI.h>

static TFT_eSPI tft = TFT_eSPI();

// Laid out for the small panels; on a 5"/7" it simply uses the top-left.
static const int16_t  PANEL_MARGIN    = 8;
static const int16_t  PANEL_ROW_H     = 22;
static const uint8_t  PANEL_FONT      = 2;
static int16_t        panelCursorY    = 0;

inline uint16_t panelColor(DisplayTone tone) {
  switch (tone) {
    case DISPLAY_OK:    return TFT_GREEN;
    case DISPLAY_BAD:   return TFT_RED;
    case DISPLAY_MUTED: return TFT_DARKGREY;
    default:            return TFT_WHITE;
  }
}

inline void displayInit() {
  tft.init();
  tft.setRotation(1);
  tft.fillScreen(TFT_BLACK);
}

// Redrawn whole each poll. The report is a dozen short lines every five
// seconds, so there is nothing to gain from diffing it, and a partial redraw
// that misses a cleared field shows a stale number next to a fresh one —
// the one failure a status display must not have.
inline void displayBegin() {
  tft.fillScreen(TFT_BLACK);
  panelCursorY = PANEL_MARGIN;
}

inline void displayTitle(const String& text) {
  tft.setTextColor(TFT_CYAN, TFT_BLACK);
  tft.drawString(text, PANEL_MARGIN, panelCursorY, PANEL_FONT);
  panelCursorY += PANEL_ROW_H + 4;
}

inline void displayLine(const String& label, const String& value, DisplayTone tone) {
  tft.setTextColor(TFT_DARKGREY, TFT_BLACK);
  tft.drawString(label, PANEL_MARGIN, panelCursorY, PANEL_FONT);
  tft.setTextColor(panelColor(tone), TFT_BLACK);
  tft.drawString(value, PANEL_MARGIN + 90, panelCursorY, PANEL_FONT);
  panelCursorY += PANEL_ROW_H;
}

inline void displayFooter(const String& note) {
  if (!note.length()) return;
  tft.setTextColor(TFT_DARKGREY, TFT_BLACK);
  tft.drawString(note, PANEL_MARGIN, tft.height() - PANEL_ROW_H - PANEL_MARGIN, PANEL_FONT);
}

inline void displayEnd() {}

#endif
