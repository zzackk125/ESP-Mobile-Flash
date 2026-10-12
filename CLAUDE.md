# ESP Mobile Flash (tooling repo)

- `tools/build_firmware.py` + `.github/workflows/build-firmware.yml`: reusable build/publish pipeline that
  project repos call; keep the manifest format (README "Firmware branch format") backwards compatible,
  since `web/app.js` reads it.
- `ota/mobile_flash_ota.cpp` must stay framework-agnostic (Arduino + ESP-IDF 4.4+) and must keep the
  `[mobile-flash-ota]` log prefix: the build script greps for it and the flasher parses the `ready:` line.
- `web/` is a static site with no build step; third-party code is vendored in `web/vendor/` (no CDNs —
  the page holds a GitHub token, keep the CSP strict).
- Local test: `cd template && python3 ../tools/build_firmware.py --out-dir /tmp/fw`.
