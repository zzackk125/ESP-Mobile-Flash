# ESP32 project (ESP Mobile Flash)

This project is flashed from a phone. Follow the conventions in
https://github.com/zzackk125/ESP-Mobile-Flash/blob/main/PROJECT_SETUP.md

Short version:
- PlatformIO, one `[env:*]` per board; CI builds every env on push and publishes
  flashable images to the branch `firmware/<branch>`.
- Never commit secrets; Wi-Fi credentials are set over serial via `wifi_setup.h`.
- Log status over `Serial` at 115200; keep `loop()` non-blocking.
- Port 8032 is reserved for the OTA update server.
- After pushing, tell the user which branch to pick in the flasher.
