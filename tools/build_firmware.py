#!/usr/bin/env python3
"""Build every PlatformIO environment of an ESP32 project into flashable images.

For each [env:*] in platformio.ini this produces:

    <out>/<env>/standard.merged.bin   bootloader + partitions + app, flash at 0x0
    <out>/<env>/standard.app.bin      app only (for OTA updates)
    <out>/<env>/ota.merged.bin        same, with the Mobile Flash OTA server added
    <out>/<env>/ota.app.bin

and a single <out>/manifest.json the mobile flasher reads.

Usage:
    build_firmware.py --project-dir . --out-dir firmware-out [--envs a,b] [--no-ota]
"""

import argparse
import datetime
import json
import os
import shutil
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OTA_SOURCE = os.path.join(HERE, "..", "ota", "mobile_flash_ota.cpp")
OTA_DEST_NAME = "zz_mobile_flash_ota.cpp"
OTA_MARKER = b"[mobile-flash-ota]"  # string inside the OTA code; proves it was linked

# chip_id field of the ESP image extended header -> chip name used by esptool-js
CHIP_IDS = {
    0x0000: "ESP32",
    0x0002: "ESP32-S2",
    0x0005: "ESP32-C3",
    0x0009: "ESP32-S3",
    0x000C: "ESP32-C2",
    0x000D: "ESP32-C6",
    0x0010: "ESP32-H2",
    0x0012: "ESP32-P4",
    0x0014: "ESP32-C61",
    0x0017: "ESP32-C5",
}

FLASH_SIZES = {0: "1MB", 1: "2MB", 2: "4MB", 3: "8MB", 4: "16MB", 5: "32MB", 6: "64MB", 7: "128MB"}


def log(msg):
    print(f"[mobile-flash] {msg}", flush=True)


def pio(args, project_dir, capture=False):
    cmd = ["pio"] + args + ["-d", project_dir]
    if capture:
        return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout
    subprocess.run(cmd, check=True)


def project_config(project_dir):
    """Return {section: {option: value}} as PlatformIO resolves it."""
    raw = json.loads(pio(["project", "config", "--json-output"], project_dir, capture=True))
    return {section: dict(options) for section, options in raw}


def env_metadata(project_dir, env):
    out = pio(["project", "metadata", "-e", env, "--json-output"], project_dir, capture=True)
    return json.loads(out)[env]


def parse_partitions(data):
    """Parse a binary ESP partition table into a list of dicts."""
    parts = []
    for i in range(0, len(data) - 31, 32):
        entry = data[i:i + 32]
        if entry[:2] != b"\xaa\x50":
            break  # 0xFFFF end marker or 0xEBEB md5 entry
        ptype, subtype, offset, size = struct.unpack_from("<BBII", entry, 2)
        label = entry[12:28].split(b"\x00")[0].decode(errors="replace")
        parts.append({"type": ptype, "subtype": subtype, "offset": offset, "size": size, "label": label})
    return parts


def app_offset_and_ota(partitions):
    apps = [p for p in partitions if p["type"] == 0]
    if not apps:
        raise RuntimeError("partition table has no app partition")
    factory = [p for p in apps if p["subtype"] == 0x00]
    ota_slots = [p for p in apps if 0x10 <= p["subtype"] <= 0x1F]
    has_otadata = any(p["type"] == 1 and p["subtype"] == 0x00 for p in partitions)
    boot = factory[0] if factory else (sorted(ota_slots, key=lambda p: p["subtype"]) or apps)[0]
    max_app = min(p["size"] for p in (ota_slots or [boot]))
    return boot["offset"], len(ota_slots) >= 2 and has_otadata, max_app


def bootloader_info(data):
    if len(data) < 24 or data[0] != 0xE9:
        raise RuntimeError("bootloader.bin is not an ESP image")
    chip_id = struct.unpack_from("<H", data, 12)[0]
    chip = CHIP_IDS.get(chip_id, f"unknown-0x{chip_id:04x}")
    flash_size = FLASH_SIZES.get(data[3] >> 4, "unknown")
    return chip, flash_size


def merge_images(images):
    """images: list of (offset, bytes). Gaps are padded with 0xFF like esptool merge_bin."""
    end = max(off + len(blob) for off, blob in images)
    out = bytearray(b"\xff" * end)
    for off, blob in sorted(images):
        out[off:off + len(blob)] = blob
    return bytes(out)


def read(path):
    with open(path, "rb") as f:
        return f.read()


def collect(project_dir, env, out_env_dir, variant):
    meta = env_metadata(project_dir, env)
    build_dir = os.path.dirname(meta["prog_path"])
    app_path = os.path.splitext(meta["prog_path"])[0] + ".bin"
    flash_images = (meta.get("extra") or {}).get("flash_images") or []

    images = [(int(img["offset"], 16), read(img["path"])) for img in flash_images]
    boot_paths = [img["path"] for img in flash_images if os.path.basename(img["path"]).startswith("bootloader")]
    if not boot_paths:
        raise RuntimeError(f"{env}: no bootloader image reported by PlatformIO")
    bootloader = read(boot_paths[0])
    partitions_blob = read(os.path.join(build_dir, "partitions.bin"))

    chip, flash_size = bootloader_info(bootloader)
    app_offset, ota_capable, max_app = app_offset_and_ota(parse_partitions(partitions_blob))
    app = read(app_path)
    if len(app) > max_app:
        raise RuntimeError(f"{env}: app ({len(app)} bytes) does not fit its partition ({max_app} bytes)")

    merged = merge_images(images + [(app_offset, app)])
    os.makedirs(out_env_dir, exist_ok=True)
    merged_name, app_name = f"{variant}.merged.bin", f"{variant}.app.bin"
    with open(os.path.join(out_env_dir, merged_name), "wb") as f:
        f.write(merged)
    with open(os.path.join(out_env_dir, app_name), "wb") as f:
        f.write(app)
    log(f"{env}/{variant}: {chip}, flash {flash_size}, app @0x{app_offset:x}, "
        f"merged {len(merged)} B, app {len(app)} B, ota-capable={ota_capable}")
    return {
        "chip": chip,
        "flash_size": flash_size,
        "app_offset": app_offset,
        "ota_capable": ota_capable,
        "files": {"merged": f"{env}/{merged_name}", "app": f"{env}/{app_name}",
                  "merged_size": len(merged), "app_size": len(app)},
    }


def touch_cmake(src_dir):
    """ESP-IDF projects glob their sources at CMake configure time; force a re-configure."""
    cmake = os.path.join(src_dir, "CMakeLists.txt")
    if os.path.exists(cmake):
        os.utime(cmake, None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project-dir", default=".")
    ap.add_argument("--out-dir", default="firmware-out")
    ap.add_argument("--envs", default="", help="comma separated; default = all [env:*] sections")
    ap.add_argument("--no-ota", action="store_true", help="skip building the OTA variant")
    args = ap.parse_args()

    project_dir = os.path.abspath(args.project_dir)
    out_dir = os.path.abspath(args.out_dir)
    config = project_config(project_dir)
    all_envs = [s[4:] for s in config if s.startswith("env:")]
    envs = [e.strip() for e in args.envs.split(",") if e.strip()] or all_envs
    if not envs:
        sys.exit("no [env:*] sections found in platformio.ini")

    src_dir = config.get("platformio", {}).get("src_dir", "src")
    src_dir = os.path.join(project_dir, src_dir) if not os.path.isabs(src_dir) else src_dir
    ota_dest = os.path.join(src_dir, OTA_DEST_NAME)

    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(out_dir)

    builds, failures = [], []
    for env in envs:
        section = config.get(f"env:{env}", {})
        entry = {"env": env, "board": section.get("board", ""),
                 "framework": section.get("framework", config.get("env", {}).get("framework", ""))}
        try:
            log(f"building {env} (standard)")
            pio(["run", "-e", env], project_dir)
            std = collect(project_dir, env, os.path.join(out_dir, env), "standard")
            entry.update({k: std[k] for k in ("chip", "flash_size", "app_offset", "ota_capable")})
            entry["variants"] = {"standard": std["files"]}

            if not args.no_ota and std["ota_capable"]:
                log(f"building {env} (ota)")
                shutil.copyfile(OTA_SOURCE, ota_dest)
                touch_cmake(src_dir)
                try:
                    pio(["run", "-e", env], project_dir)
                    ota = collect(project_dir, env, os.path.join(out_dir, env), "ota")
                finally:
                    os.remove(ota_dest)
                    touch_cmake(src_dir)
                with open(os.path.join(out_dir, ota["files"]["app"]), "rb") as f:
                    linked = OTA_MARKER in f.read()
                if linked:
                    entry["variants"]["ota"] = ota["files"]
                else:
                    log(f"WARNING {env}: OTA code was not compiled in (does src/CMakeLists.txt list SRCS "
                        "explicitly?); skipping OTA variant")
                    for kind in ("merged", "app"):
                        os.remove(os.path.join(out_dir, ota["files"][kind]))
            elif not std["ota_capable"]:
                log(f"{env}: partition table has no OTA slots; skipping OTA variant")
            builds.append(entry)
        except Exception as exc:  # keep building other envs, fail at the end
            log(f"ERROR in {env}: {exc}")
            failures.append(env)

    def git(*a):
        try:
            return subprocess.run(["git", "-C", project_dir] + list(a), capture_output=True,
                                  text=True, check=True).stdout.strip()
        except Exception:
            return ""

    manifest = {
        "schema": 1,
        "project": os.environ.get("GITHUB_REPOSITORY", os.path.basename(project_dir)).split("/")[-1],
        "repository": os.environ.get("GITHUB_REPOSITORY", ""),
        "branch": os.environ.get("GITHUB_REF_NAME") or git("rev-parse", "--abbrev-ref", "HEAD"),
        "commit": os.environ.get("GITHUB_SHA") or git("rev-parse", "HEAD"),
        "commit_message": git("log", "-1", "--format=%s"),
        "built_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "builds": builds,
        "failed": failures,
    }
    with open(os.path.join(out_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    log(f"wrote {os.path.join(out_dir, 'manifest.json')} ({len(builds)} builds, {len(failures)} failed)")
    if failures:
        sys.exit(f"failed environments: {', '.join(failures)}")


if __name__ == "__main__":
    main()
