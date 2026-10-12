#include <Arduino.h>

#include "wifi_setup.h"

// DevKitC boards have an addressable RGB LED; Arduino's digitalWrite() drives it via RGB_BUILTIN.
#ifndef LED_PIN
#ifdef RGB_BUILTIN
#define LED_PIN RGB_BUILTIN
#else
#define LED_PIN 2
#endif
#endif

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  Serial.println("Hello from the ESP Mobile Flash template");
  wifi_setup::begin();
}

void loop() {
  wifi_setup::loop();

  static uint32_t last_blink = 0;
  if (millis() - last_blink >= 500) {
    last_blink = millis();
    static bool on = false;
    on = !on;
    digitalWrite(LED_PIN, on ? HIGH : LOW);
  }
}
