import { ESPLoader, Transport, WebUSBSerialPort } from "./vendor/esptool-js-0.7.0.js";
import { SerialPort as UsbCdcSerialPort } from "./vendor/web-serial-polyfill-1.0.15.js";

// ---------------------------------------------------------------- helpers
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FIRMWARE_PREFIX = "firmware/";
const OTA_PORT = 8032;
const IS_ANDROID = /Android/i.test(navigator.userAgent);
const ESPRESSIF_VID = 0x303a;
const WCH_VID = 0x1a86;

const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem("mf." + key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem("mf." + key, JSON.stringify(value));
    } catch {}
  },
  del(key) {
    try {
      localStorage.removeItem("mf." + key);
    } catch {}
  },
};

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
}

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!isFinite(s)) return "";
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function fmtBytes(n) {
  return n > 1048576 ? (n / 1048576).toFixed(2) + " MB" : Math.round(n / 1024) + " KB";
}

// ---------------------------------------------------------------- log / progress
const logEl = $("log");
const MAX_LOG = 60000;
function logRaw(text) {
  const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 30;
  logEl.textContent += text;
  if (logEl.textContent.length > MAX_LOG) logEl.textContent = logEl.textContent.slice(-MAX_LOG / 2);
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}
const log = (line) => logRaw(line + "\n");
const terminal = { clean() {}, writeLine: (d) => log(d), write: (d) => logRaw(d) };

function progress(label, pct) {
  $("progress-wrap").hidden = label == null;
  if (label != null) {
    $("progress-label").textContent = label;
    $("progress").value = pct ?? 0;
  }
}

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {}
}

// ---------------------------------------------------------------- md5 (flash verification)
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
export function md5(bytes) {
  const len = bytes.length;
  const nBlocks = ((len + 8) >> 6) + 1;
  const w = new Uint32Array(nBlocks * 16);
  for (let i = 0; i < len; i++) w[i >> 2] |= bytes[i] << ((i % 4) * 8);
  w[len >> 2] |= 0x80 << ((len % 4) * 8);
  w[nBlocks * 16 - 2] = (len * 8) >>> 0;
  w[nBlocks * 16 - 1] = Math.floor(len / 0x20000000);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let blk = 0; blk < w.length; blk += 16) {
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + MD5_K[i] + w[blk + g]) >>> 0;
      const s = MD5_S[(i >> 4) * 4 + (i % 4)];
      A = D; D = C; C = B;
      B = (B + ((F << s) | (F >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  return [a0, b0, c0, d0]
    .map((x) => [0, 8, 16, 24].map((s) => ((x >>> s) & 255).toString(16).padStart(2, "0")).join(""))
    .join("");
}

// ---------------------------------------------------------------- GitHub API
let token = store.get("token", "");

async function gh(path, { raw = false, onProgress } = {}) {
  const res = await fetch("https://api.github.com" + path, {
    headers: {
      Authorization: "Bearer " + token,
      Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status} on ${path.split("?")[0]}`);
    err.status = res.status;
    throw err;
  }
  if (!raw) return res.json();
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !onProgress) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got, total);
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

const encRef = (branch) => encodeURIComponent(FIRMWARE_PREFIX + branch);

async function fetchFirmwareFile(repo, branch, path, label) {
  progress(`Downloading ${label}…`, 0);
  const data = await gh(`/repos/${repo}/contents/${path}?ref=${encRef(branch)}`, {
    raw: true,
    onProgress: (got, total) => progress(`Downloading ${label}… ${fmtBytes(got)}`, total ? (got * 100) / total : 0),
  });
  log(`Downloaded ${path} (${fmtBytes(data.length)})`);
  return data;
}

// ---------------------------------------------------------------- views
const views = ["settings", "projects", "project"];
function show(view) {
  for (const v of views) $(v).hidden = v !== view;
}

// Settings
function openSettings() {
  $("token").value = token;
  $("conn-mode").value = store.get("conn", "auto");
  $("baud").value = String(store.get("baud", 460800));
  show("settings");
}
$("btn-settings").onclick = () => ($("settings").hidden ? openSettings() : token && show(current ? "project" : "projects"));
$("btn-save-settings").onclick = async () => {
  store.set("conn", $("conn-mode").value);
  store.set("baud", Number($("baud").value));
  const t = $("token").value.trim();
  if (!t) {
    $("token-status").textContent = "Paste a token first.";
    return;
  }
  token = t;
  $("token-status").textContent = "Checking token…";
  try {
    const me = await gh("/user");
    store.set("token", token);
    store.set("login", me.login);
    $("token-status").textContent = `Signed in as ${me.login}.`;
    show("projects");
    loadProjects(true);
  } catch (e) {
    $("token-status").textContent = `Token rejected (${e.message}).`;
  }
};
$("btn-signout").onclick = () => {
  token = "";
  for (const k of ["token", "login", "projects"]) store.del(k);
  $("token").value = "";
  $("token-status").textContent = "Token removed from this browser.";
};

// Projects
let projects = store.get("projects", []);
let current = null; // { repo, branches, default_branch, private, branch, manifest }

function renderProjects() {
  const q = $("filter").value.trim().toLowerCase();
  const list = $("project-list");
  list.replaceChildren();
  for (const p of projects.filter((p) => p.full_name.toLowerCase().includes(q))) {
    list.append(
      h("li", { onclick: () => openProject(p) },
        h("div", {},
          h("div", { class: "name" }, p.name),
          h("div", { class: "muted" }, `${p.branches.length} branch${p.branches.length === 1 ? "" : "es"} · pushed ${timeAgo(p.pushed_at)}`)),
        h("span", { class: "muted" }, "›")),
    );
  }
  if (!projects.length) list.append(h("li", { class: "muted" }, "No projects with firmware builds yet."));
}
$("filter").oninput = renderProjects;
$("btn-refresh").onclick = () => loadProjects(true);

async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

async function loadProjects(force = false) {
  renderProjects();
  if (!force && projects.length) return;
  const status = $("project-status");
  try {
    status.textContent = "Listing repositories…";
    let repos = [];
    for (let page = 1; page <= 5; page++) {
      const batch = await gh(`/user/repos?per_page=100&sort=pushed&page=${page}`);
      repos = repos.concat(batch);
      if (batch.length < 100) break;
    }
    status.textContent = `Checking ${repos.length} repositories for firmware builds…`;
    const found = await mapLimit(repos, 8, async (r) => {
      try {
        const refs = await gh(`/repos/${r.full_name}/git/matching-refs/heads/${FIRMWARE_PREFIX}`);
        if (!refs.length) return null;
        return {
          full_name: r.full_name,
          name: r.name,
          private: r.private,
          pushed_at: r.pushed_at,
          default_branch: r.default_branch,
          branches: refs.map((x) => x.ref.replace("refs/heads/" + FIRMWARE_PREFIX, "")),
        };
      } catch {
        return null; // empty repo or no access
      }
    });
    projects = found.filter(Boolean);
    store.set("projects", projects);
    status.textContent = "";
    renderProjects();
  } catch (e) {
    status.textContent = `Could not load projects: ${e.message}`;
    if (e.status === 401) openSettings();
  }
}

// Project detail
async function openProject(p) {
  current = { ...p, manifest: null, branch: null };
  show("project");
  $("proj-name").textContent = p.name;
  $("proj-visibility").textContent = p.private ? "private" : "public";
  $("ota-host").value = store.get("ota." + p.full_name, "");
  const branches = [...p.branches].sort((a, b) =>
    a === p.default_branch ? -1 : b === p.default_branch ? 1 : a.localeCompare(b),
  );
  $("branch").replaceChildren(...branches.map((b) => h("option", { value: b }, b)));
  const last = store.get("branch." + p.full_name);
  if (last && branches.includes(last)) $("branch").value = last;
  await loadManifest();
}
$("btn-back").onclick = () => {
  current = null;
  show("projects");
};
$("branch").onchange = () => loadManifest();

async function loadManifest() {
  const branch = $("branch").value;
  current.branch = branch;
  current.manifest = null;
  store.set("branch." + current.full_name, branch);
  $("build-meta").textContent = "Loading build manifest…";
  $("build-list").replaceChildren();
  $("downloads").replaceChildren();
  try {
    const raw = await gh(`/repos/${current.full_name}/contents/manifest.json?ref=${encRef(branch)}`, { raw: true });
    const m = JSON.parse(new TextDecoder().decode(raw));
    current.manifest = m;
    $("build-meta").replaceChildren(
      ...[
        h("div", {}, `Built ${timeAgo(m.built_at)} from `, h("code", {}, (m.commit || "").slice(0, 7))),
        m.commit_message ? h("div", {}, m.commit_message) : null,
        m.failed?.length ? h("div", { class: "err" }, `Failed to build: ${m.failed.join(", ")}`) : null,
      ].filter(Boolean),
    );
    renderBuilds();
  } catch (e) {
    $("build-meta").textContent = `No manifest on ${FIRMWARE_PREFIX}${branch}: ${e.message}`;
  }
}

function selectedBuild() {
  const env = document.querySelector('input[name="build"]:checked')?.value;
  return current?.manifest?.builds.find((b) => b.env === env) || null;
}

function renderBuilds() {
  const builds = current.manifest.builds;
  const preferred = store.get("env." + current.full_name);
  const list = $("build-list");
  list.replaceChildren(
    ...builds.map((b, i) =>
      h("label", { class: "build" },
        h("input", {
          type: "radio", name: "build", value: b.env,
          checked: preferred ? b.env === preferred : i === 0,
          onchange: () => {
            store.set("env." + current.full_name, b.env);
            updateBuildOptions();
          },
        }),
        h("div", {},
          h("div", { class: "title" }, b.env),
          h("div", { class: "muted" }, `${b.chip} · ${b.board} · ${b.flash_size} flash`))),
    ),
  );
  if (!list.querySelector("input:checked") && builds.length) list.querySelector("input").checked = true;
  updateBuildOptions();
}

function updateBuildOptions() {
  const b = selectedBuild();
  const hasOta = !!b?.variants?.ota;
  $("ota-enable").disabled = !hasOta;
  $("ota-enable").checked = hasOta && store.get("ota-default", true);
  $("btn-flash").disabled = !b;
  $("btn-ota").disabled = !hasOta;
  const dl = $("downloads");
  dl.replaceChildren();
  if (!b) return;
  for (const [variant, files] of Object.entries(b.variants)) {
    for (const kind of ["merged", "app"]) {
      const path = files[kind];
      dl.append(
        h("button", { class: "small", onclick: () => downloadToDevice(path) },
          `${variant} · ${kind === "merged" ? "full (0x0)" : "app only"} · ${fmtBytes(files[kind + "_size"])}`),
      );
    }
  }
}
$("ota-enable").onchange = () => store.set("ota-default", $("ota-enable").checked);

async function downloadToDevice(path) {
  try {
    const data = await fetchFirmwareFile(current.full_name, current.branch, path, path);
    const name = `${current.name}-${current.branch}-${path.replaceAll("/", "-")}`.replace(/[^\w.-]+/g, "_");
    const url = URL.createObjectURL(new Blob([data], { type: "application/octet-stream" }));
    h("a", { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    log(`Download failed: ${e.message}`);
  } finally {
    progress(null);
  }
}

// ---------------------------------------------------------------- USB ports
function connMode() {
  const mode = store.get("conn", "auto");
  if (mode !== "auto") return mode;
  if (IS_ANDROID && "usb" in navigator) return "usb";
  return "serial" in navigator ? "serial" : "usb";
}

function wrapUsbDevice(dev) {
  if (dev.vendorId === WCH_VID) return new WebUSBSerialPort(dev).asSerialPort();
  return new UsbCdcSerialPort(dev);
}

let lastPortInfo = null;

// Must be called directly from a click handler (browser permission prompt).
async function requestPort() {
  const mode = connMode();
  if (mode === "serial") {
    if (!("serial" in navigator)) throw new Error("Web Serial is not available in this browser.");
    const port = await navigator.serial.requestPort();
    lastPortInfo = port.getInfo();
    return port;
  }
  if (!("usb" in navigator)) throw new Error("WebUSB is not available — open this page in Chrome.");
  const dev = await navigator.usb.requestDevice({
    filters: [{ vendorId: ESPRESSIF_VID }, { vendorId: WCH_VID }, { classCode: 2 }],
  });
  lastPortInfo = { usbVendorId: dev.vendorId, usbProductId: dev.productId };
  return wrapUsbDevice(dev);
}

// Re-use an already-permitted port (e.g. after the board re-enumerated); else prompt.
async function getPort() {
  const mode = connMode();
  if (lastPortInfo) {
    const same = (vid, pid) => vid === lastPortInfo.usbVendorId && pid === lastPortInfo.usbProductId;
    if (mode === "serial" && "serial" in navigator) {
      const ports = await navigator.serial.getPorts();
      const p = ports.find((p) => same(p.getInfo().usbVendorId, p.getInfo().usbProductId));
      if (p) return p;
    } else if ("usb" in navigator) {
      const devs = await navigator.usb.getDevices();
      const d = devs.find((d) => same(d.vendorId, d.productId));
      if (d) return wrapUsbDevice(d);
    }
  }
  return requestPort();
}

// ---------------------------------------------------------------- flashing
let busy = false;
function setBusy(on) {
  busy = on;
  for (const id of ["btn-flash", "btn-local-flash", "btn-ota", "btn-monitor"]) $(id).disabled = on;
  if (!on) updateBuildOptions();
}

async function flashImage({ port, data, address, expectChip, eraseAll }) {
  await monitor.stop();
  const isNativeUsb = lastPortInfo?.usbVendorId === ESPRESSIF_VID;
  const transport = new Transport(port, false);
  const loader = new ESPLoader({
    transport,
    baudrate: isNativeUsb ? 115200 : store.get("baud", 460800),
    terminal,
    debugLogging: false,
  });
  try {
    progress("Connecting to board…", 0);
    log("Connecting…");
    await loader.main();
    const chip = loader.chip.CHIP_NAME;
    $("dev-chip").textContent = chip;
    if (expectChip && chip !== expectChip) {
      throw new Error(`This build is for ${expectChip} but the board is ${chip}. Pick the matching build.`);
    }
    if (eraseAll) {
      progress("Erasing flash (can take ~30 s)…", 0);
      log("Erasing entire flash…");
      await loader.eraseFlash();
    }
    progress("Flashing…", 0);
    const t0 = Date.now();
    await loader.writeFlash({
      fileArray: [{ data, address }],
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (_i, written, total) =>
        progress(`Flashing… ${Math.round((written * 100) / total)}%`, (written * 100) / total),
      calculateMD5Hash: md5,
    });
    log(`Flashed and verified ${fmtBytes(data.length)} in ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
    progress("Resetting board…", 100);
    await loader.after("hard_reset");
  } finally {
    try {
      await transport.disconnect();
    } catch {}
  }
}

$("btn-flash").onclick = async () => {
  if (busy) return;
  const b = selectedBuild();
  if (!b) return;
  const variant = $("ota-enable").checked && b.variants.ota ? "ota" : "standard";
  setBusy(true);
  await keepAwake(true);
  try {
    const port = await requestPort(); // first, while the tap still counts as a user gesture
    const data = await fetchFirmwareFile(current.full_name, current.branch, b.variants[variant].merged,
      `${b.env} (${variant})`);
    await flashImage({ port, data, address: 0, expectChip: b.chip, eraseAll: $("erase-all").checked });
    log(`✓ ${current.name} ${b.env} (${variant}) flashed. Board restarted.`);
    if (variant === "ota") log("Open the serial monitor to see the device's Wi-Fi update address.");
    progress("Done ✓", 100);
  } catch (e) {
    log(`✗ ${e.message || e}`);
    progress(null);
  } finally {
    setBusy(false);
    keepAwake(false);
  }
};

$("btn-local-flash").onclick = async () => {
  if (busy) return;
  const file = $("local-file").files[0];
  if (!file) return log("Choose a .bin file first.");
  const address = parseInt($("local-offset").value, 16);
  if (!Number.isFinite(address)) return log("Offset must be hex, e.g. 0x0 or 0x10000.");
  setBusy(true);
  await keepAwake(true);
  try {
    const port = await requestPort();
    const data = new Uint8Array(await file.arrayBuffer());
    await flashImage({ port, data, address, eraseAll: false });
    log(`✓ ${file.name} flashed at 0x${address.toString(16)}.`);
    progress("Done ✓", 100);
  } catch (e) {
    log(`✗ ${e.message || e}`);
    progress(null);
  } finally {
    setBusy(false);
    keepAwake(false);
  }
};

// ---------------------------------------------------------------- serial monitor
const monitor = {
  port: null,
  reader: null,
  running: false,
  async start(port) {
    await port.open({ baudRate: 115200 });
    try {
      await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    } catch {}
    this.port = port;
    this.running = true;
    $("btn-monitor").textContent = "Stop monitor";
    $("btn-reset").disabled = false;
    $("send-form").hidden = false;
    log("— serial monitor connected (115200) —");
    this.loop();
  },
  async loop() {
    const decoder = new TextDecoder();
    let pending = "";
    while (this.running && this.port?.readable) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true }).replace(/\x1b\[[0-9;]*m/g, "");
          logRaw(text);
          pending = (pending + text).slice(-400);
          const m = pending.match(/\[mobile-flash-ota\] ready: http:\/\/([\d.]+:\d+)\//);
          if (m && current) {
            const host = m[1].endsWith(":" + OTA_PORT) ? m[1].split(":")[0] : m[1];
            if ($("ota-host").value !== host) {
              $("ota-host").value = host;
              store.set("ota." + current.full_name, host);
            }
            pending = "";
          }
        }
      } catch (e) {
        if (this.running) log(`— monitor: ${e.message || e} —`);
        break;
      } finally {
        try { this.reader.releaseLock(); } catch {}
      }
    }
    if (this.running) await this.stop();
  },
  async stop() {
    if (!this.port) return;
    this.running = false;
    try { await this.reader?.cancel(); } catch {}
    try { await this.port.close(); } catch {}
    this.port = null;
    this.reader = null;
    $("btn-monitor").textContent = "Serial monitor";
    $("btn-reset").disabled = true;
    $("send-form").hidden = true;
    log("— serial monitor closed —");
  },
  async send(text) {
    if (!this.port?.writable) return;
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(text + "\r\n"));
    } finally {
      writer.releaseLock();
    }
  },
  async reset() {
    if (!this.port) return;
    await this.port.setSignals({ dataTerminalReady: false, requestToSend: true });
    await sleep(120);
    await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
  },
};

$("btn-monitor").onclick = async () => {
  if (monitor.port) return monitor.stop();
  try {
    await monitor.start(await getPort());
  } catch (e) {
    log(`✗ Monitor: ${e.message || e}`);
  }
};
$("btn-reset").onclick = () => monitor.reset().catch((e) => log(`✗ Reset: ${e.message}`));
$("btn-clear").onclick = () => (logEl.textContent = "");
$("send-form").onsubmit = (e) => {
  e.preventDefault();
  const text = $("send-text").value;
  $("send-text").value = "";
  monitor.send(text).catch((err) => log(`✗ Send: ${err.message}`));
};

// ---------------------------------------------------------------- Wi-Fi (OTA) update
// The flasher is served over HTTPS and can't fetch() a plain-HTTP device, so it opens the
// device's own upload page in a new tab and hands it the firmware with postMessage.
let otaWin = null;
let otaReady = null;

window.addEventListener("message", (e) => {
  if (!otaWin || e.source !== otaWin || !e.data || e.data.type !== "mf-ota-status") return;
  const m = e.data;
  if (m.state === "ready") {
    if (m.info) log(`Device: ${m.info.project} ${m.info.version} (${m.info.chip}, running ${m.info.running})`);
    otaReady?.();
  }
  if (typeof m.progress === "number") progress(`Uploading over Wi-Fi… ${m.progress}%`, m.progress);
  if (m.text && m.state !== "uploading") log((m.state === "error" ? "✗ " : m.state === "done" ? "✓ " : "") + m.text);
  if (m.state === "done") progress("Done ✓ — device rebooting", 100);
  if (m.state === "done" || m.state === "error") setBusy(false);
});

$("btn-ota").onclick = async () => {
  if (busy) return;
  const b = selectedBuild();
  if (!b?.variants?.ota) return;
  let host = $("ota-host").value.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!host) return log("Enter the device address (shown in the serial monitor).");
  if (!host.includes(":")) host += ":" + OTA_PORT;
  store.set("ota." + current.full_name, $("ota-host").value.trim());

  // Open the tab synchronously inside the tap so the popup isn't blocked.
  otaWin = window.open(`http://${host}/`, "mf-ota");
  if (!otaWin) return log("✗ Popup blocked — allow popups for this site and retry.");
  const ready = new Promise((resolve) => (otaReady = resolve));
  setBusy(true);
  try {
    const data = await fetchFirmwareFile(current.full_name, current.branch, b.variants.ota.app, `${b.env} (ota app)`);
    progress("Waiting for the device page…", 0);
    const ok = await Promise.race([ready.then(() => true), sleep(20000).then(() => false)]);
    if (!ok) throw new Error(`No answer from http://${host}/ — check the address and that phone and device share a network.`);
    log(`Sending ${fmtBytes(data.length)} to ${host}…`);
    otaWin.postMessage({ type: "mf-ota-image", name: `${b.env}.ota.app.bin`, data: data.buffer }, "*", [data.buffer]);
    // completion arrives via the message listener
  } catch (e) {
    log(`✗ ${e.message || e}`);
    progress(null);
    setBusy(false);
  }
};

// ---------------------------------------------------------------- boot
function init() {
  if (!("serial" in navigator) && !("usb" in navigator)) $("browser-warning").hidden = false;
  if (!token) {
    openSettings();
    $("token-status").textContent = "Add a token to see your projects.";
  } else {
    show("projects");
    loadProjects(false);
  }
  if ("usb" in navigator) navigator.usb.addEventListener("disconnect", () => monitor.port && log("— USB device disconnected —"));
}
init();
