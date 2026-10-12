# ESP Mobile Flash

Build ESP32 firmware in GitHub Actions and flash it from an Android phone, for
any number of **private** project repos.

```
project repo (private)                         this repo (public, no secrets)
──────────────────────                         ─────────────────────────────
push ─► .github/workflows/firmware.yml ──uses──► build-firmware.yml (reusable)
                                                  ├─ pio run for every [env:*]
                                                  ├─ merge bootloader+partitions+app → one .bin
                                                  ├─ optional OTA variant (ota/mobile_flash_ota.cpp)
        branch firmware/<branch> ◄── publish ─────┘  + manifest.json
                 │
                 │  GitHub API + your read-only token (stored only on your phone)
                 ▼
        Flasher web app ── https://zzackk125.github.io/ESP-Mobile-Flash/
          ├─ Flash over USB (Chrome, WebUSB / Web Serial, esptool-js, MD5-verified)
          ├─ Update over Wi-Fi (OTA builds)
          └─ Serial monitor
```

## One-time setup

1. **Make this repo public.** It holds only the generic tools and the flasher page,
   no project code or secrets. Private projects need to download the build scripts
   from it, and GitHub Pages is free only for public repos.
   *Settings → General → Danger zone → Change visibility.*
2. **Enable Pages.** *Settings → Pages → Build and deployment → Source: GitHub Actions.*
   The `Deploy flasher to Pages` workflow publishes `web/` on every push to `main`
   (re-run it from the Actions tab after enabling).
3. **Create a token for your phone.** Go to
   [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new):
   - Repository access: *All repositories*, or just your ESP projects
   - Permissions → Repository → **Contents: Read-only** (Metadata is added automatically)
4. **On your phone, in Chrome**, open `https://zzackk125.github.io/ESP-Mobile-Flash/`,
   paste the token, then use *⋮ → Add to Home screen*.

Firefox can't access USB (it has no Web Serial or WebUSB support), so use Chrome
for flashing. Wi-Fi updates and downloads also work in Firefox.

## Adding a project

Each project repo needs two things (or copy everything from [`template/`](template)):

- a `platformio.ini` with one `[env:*]` per board you want to flash
- [`template/.github/workflows/firmware.yml`](template/.github/workflows/firmware.yml), copied to `.github/workflows/firmware.yml`

Every push then builds all envs and publishes them to `firmware/<branch>`. Feature
branches work too, so you can flash work in progress before merging. Deleting a
branch deletes its firmware branch.

For the full conventions (used when Claude creates projects), see
[PROJECT_SETUP.md](PROJECT_SETUP.md).

## Flashing

1. Connect the board to the phone with a USB-C data cable (or an OTG adapter),
   using the board's **native USB** port.
2. Open the flasher, then pick the project, branch and build. The build list shows
   the chip, and the flasher refuses to write an S3 build to a C6 and vice versa.
3. Tick **Include Wi-Fi updates (OTA)** if you want to update this board wirelessly later.
4. Tap **Flash over USB** and pick the device in Chrome's prompt.

If connecting fails, put the board in download mode: hold **BOOT**, tap **RESET**,
release **BOOT**.

| Board USB | Android (Chrome) | Desktop Chrome/Edge |
|---|---|---|
| Native USB (S3, C6, C3, C5, H2) | ✅ WebUSB | ✅ |
| CH340 / CH341 | ✅ WebUSB | ✅ |
| CP210x, FTDI, CH343 | ❌ use the native USB port | ✅ |

## Wi-Fi (OTA) updates

When the OTA option is ticked, the flasher writes the build's **ota** variant: your
firmware plus [`ota/mobile_flash_ota.cpp`](ota/mobile_flash_ota.cpp). Your project
code doesn't need to change. Once the project connects to Wi-Fi, the device prints

```
[mobile-flash-ota] ready: http://192.168.1.50:8032/
```

The flasher's serial monitor picks up that address automatically. After that,
**Update over Wi-Fi** sends new builds without a cable. The flasher opens the
device's own upload page and hands it the firmware. That's needed because an HTTPS
page can't send requests to a plain-HTTP device directly.

- The project has to connect to Wi-Fi itself. The template's
  [`wifi_setup.h`](template/src/wifi_setup.h) does that, with credentials typed into
  the serial monitor (`wifi <ssid> <password>`). They're stored on the device and
  never appear in source code or builds.
- The device rejects images for a different chip and corrupted images, and it
  only switches to the new firmware after the image verifies.
- The OTA variant is only built if the partition table has two OTA slots. That's
  the default for Arduino boards with 4 MB+ flash.
- The update server has no password. Anyone on the same network can push firmware
  to the device. That's fine for a home LAN, but don't use OTA builds on untrusted
  networks.

## Repo layout

| Path | What |
|---|---|
| `.github/workflows/build-firmware.yml` | Reusable build-and-publish workflow that projects call |
| `.github/workflows/pages.yml` | Deploys the flasher (`web/`) to GitHub Pages |
| `.github/workflows/self-test.yml` | Builds `template/` with the current tools on every change |
| `tools/build_firmware.py` | Builds all envs, merges images, writes `manifest.json` |
| `ota/mobile_flash_ota.cpp` | Drop-in Wi-Fi update server (Arduino + ESP-IDF) |
| `web/` | Flasher web app (static; esptool-js and web-serial-polyfill vendored in `web/vendor/`) |
| `template/` | Starter project (S3 + C6, Wi-Fi setup over serial) |

### Firmware branch format

```
firmware/<branch>/
  manifest.json                 project, commit, build time, builds[]
  <env>/standard.merged.bin     flash at 0x0 (bootloader + partition table + app)
  <env>/standard.app.bin        app only
  <env>/ota.merged.bin          same, with the OTA server
  <env>/ota.app.bin             what "Update over Wi-Fi" sends
```

## Free-tier limits

Private repos get 2,000 GitHub Actions minutes a month. A two-board project with
the OTA variant takes about 3–5 minutes per push once the PlatformIO cache is warm,
so that's a few hundred builds a month. To save minutes, limit `environments:` or
set `ota-variant: false` in a project's `firmware.yml`.
