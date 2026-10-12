# Project conventions for ESP Mobile Flash

Instructions for setting up and working on an ESP32 project repo so it can be
flashed from a phone. When starting a new project, tell Claude:
"set it up per zzackk125/ESP-Mobile-Flash/PROJECT_SETUP.md".

## Required in every project

1. **PlatformIO project at the repo root** (or set `project-dir` in the workflow).
   - Use the pioarduino platform, which is needed for the ESP32-C6 and current Arduino-ESP32:
     `platform = https://github.com/pioarduino/platform-espressif32/releases/download/stable/platform-espressif32.zip`
   - One `[env:<name>]` per board the user owns. Name envs after the board,
     e.g. `esp32-s3`, `xiao-c6`.
   - ESP32-S3 with native USB: `build_flags = -DARDUINO_USB_CDC_ON_BOOT=1` so `Serial`
     is visible over the same cable used for flashing. **Don't** set it for the C6
     (its board definition already handles USB, and the flag breaks the build).
   - Keep a partition table with two OTA slots (the Arduino default for 4 MB+ flash),
     or use something like `board_build.partitions = min_spiffs.csv` if the app is
     large. Without OTA slots the Wi-Fi update option is disabled.
2. **`.github/workflows/firmware.yml`**: copy it verbatim from
   `template/.github/workflows/firmware.yml` in this repo.
3. **`.gitignore`** with `.pio/`.

## Code conventions

- `Serial.begin(115200)` early in `setup()` and log useful status. The phone's
  serial monitor is the only debugger available.
- **No secrets in source or build flags** (Wi-Fi passwords, API keys). Wi-Fi:
  copy `template/src/wifi_setup.h` and call `wifi_setup::begin()` in `setup()` and
  `wifi_setup::loop()` in `loop()`. The user sets credentials from the serial monitor
  with `wifi <ssid> <password>`. Other secrets go in NVS (`Preferences`) the same way.
- Non-blocking `loop()` (`millis()` timing, not long `delay()`s), so serial commands
  and Wi-Fi stay responsive.
- If the project runs its own web server, don't use port 8032 (the OTA server
  uses it).
- Pin numbers differ per board: put them behind `#ifdef` per env, or in
  `build_flags` (`-DLED_PIN=48`) in each `[env:*]`.

## Before pushing

- Build locally if the environment allows (`pio run`). Otherwise rely on the
  `Firmware` workflow, and check that it passed on the pushed branch.
- Every push publishes `firmware/<branch>`. Tell the user the branch name, so they
  pick it in the flasher.
