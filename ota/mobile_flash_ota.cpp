// ESP Mobile Flash - drop-in Wi-Fi OTA update server.
//
// The build pipeline copies this file into a project's src/ directory to make
// the "ota" firmware variant. It needs no calls from the project: a global
// constructor starts a background task that waits until the device has an IP
// address (the project's own Wi-Fi code connects), then serves:
//
//   GET  http://<ip>:8032/        upload page (also receives images from the mobile flasher)
//   GET  http://<ip>:8032/info    JSON describing the running firmware
//   POST http://<ip>:8032/update  raw app .bin -> written to the next OTA slot, then reboot
//
// Works with the Arduino and ESP-IDF frameworks (ESP-IDF 4.4+).

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_http_server.h"
#include "esp_idf_version.h"
#include "esp_netif.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
#include "esp_app_desc.h"
#endif

#ifdef ARDUINO
#include <Arduino.h>
#endif

#ifndef MOBILE_FLASH_OTA_PORT
#define MOBILE_FLASH_OTA_PORT 8032
#endif

namespace {

const char *kTag = "[mobile-flash-ota]";

void mf_log(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
void mf_log(const char *fmt, ...) {
  char buf[160];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);
#ifdef ARDUINO
  // Serial is where Arduino projects (and the flasher's serial monitor) look.
  Serial.printf("%s %s\n", kTag, buf);
#else
  printf("%s %s\n", kTag, buf);
#endif
}

const esp_app_desc_t *app_desc() {
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
  return esp_app_get_description();
#else
  return esp_ota_get_app_description();
#endif
}

const char kPage[] = R"HTML(<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OTA update</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;padding:16px;background:#111;color:#eee}
.card{max-width:480px;margin:auto;background:#1c1c1c;border-radius:12px;padding:16px}
h1{font-size:20px;margin:0 0 8px}code{color:#9cf}.muted{color:#999;font-size:14px}
progress{width:100%;height:18px}button,input{font-size:16px;margin:8px 0}
#st{white-space:pre-wrap;margin-top:8px}
</style></head><body><div class="card">
<h1>Wi-Fi firmware update</h1>
<div id="info" class="muted">Loading device info...</div>
<p class="muted">Pick an <code>.app.bin</code> file, or send one from the ESP Mobile Flash page.</p>
<input type="file" id="f" accept=".bin"><br>
<button id="go">Upload</button>
<progress id="p" value="0" max="100"></progress>
<div id="st"></div>
</div><script>
const $=id=>document.getElementById(id);
const opener=window.opener;
function tell(msg){ if(opener){ try{opener.postMessage(Object.assign({type:'mf-ota-status'},msg),'*');}catch(e){} } }
function status(text,state){ $('st').textContent=text; tell({text,state}); }
function upload(buf,name){
  status('Uploading '+(name||'firmware')+' ('+buf.byteLength+' bytes)...','uploading');
  const x=new XMLHttpRequest();
  x.open('POST','/update');
  x.setRequestHeader('Content-Type','application/octet-stream');
  x.upload.onprogress=e=>{ if(e.lengthComputable){ const pc=Math.round(e.loaded*100/e.total); $('p').value=pc; tell({progress:pc}); } };
  x.onload=()=>{ if(x.status==200){ $('p').value=100; status('Update OK - device is rebooting.','done'); }
                 else status('Update failed: '+x.status+' '+x.responseText,'error'); };
  x.onerror=()=>status('Connection lost during upload.','error');
  x.send(buf);
}
$('go').onclick=async()=>{ const f=$('f').files[0]; if(!f){status('Choose a file first.');return;} upload(await f.arrayBuffer(),f.name); };
window.addEventListener('message',e=>{
  if(e.source!==opener||!e.data||e.data.type!=='mf-ota-image') return;
  upload(e.data.data,e.data.name);
});
fetch('/info').then(r=>r.json()).then(i=>{
  $('info').textContent=i.project+' '+i.version+' ('+i.chip+', running '+i.running+')';
  tell({state:'ready',info:i});
}).catch(()=>{ $('info').textContent=''; tell({state:'ready'}); });
</script></body></html>)HTML";

esp_err_t handle_root(httpd_req_t *req) {
  httpd_resp_set_type(req, "text/html");
  return httpd_resp_send(req, kPage, sizeof(kPage) - 1);
}

esp_err_t handle_info(httpd_req_t *req) {
  const esp_app_desc_t *d = app_desc();
  const esp_partition_t *running = esp_ota_get_running_partition();
  char json[384];
  snprintf(json, sizeof(json),
           "{\"project\":\"%s\",\"version\":\"%s\",\"idf\":\"%s\",\"chip\":\"%s\","
           "\"built\":\"%s %s\",\"running\":\"%s\",\"ota\":%s}",
           d->project_name, d->version, d->idf_ver, CONFIG_IDF_TARGET, d->date, d->time,
           running ? running->label : "?",
           esp_ota_get_next_update_partition(NULL) ? "true" : "false");
  httpd_resp_set_type(req, "application/json");
  return httpd_resp_sendstr(req, json);
}

void restart_task(void *) {
  vTaskDelay(pdMS_TO_TICKS(1000));
  esp_restart();
}

esp_err_t fail(httpd_req_t *req, const char *status, const char *msg) {
  mf_log("update failed: %s", msg);
  httpd_resp_set_status(req, status);
  return httpd_resp_sendstr(req, msg);
}

esp_err_t handle_update(httpd_req_t *req) {
  const esp_partition_t *part = esp_ota_get_next_update_partition(NULL);
  if (!part) return fail(req, "500 Internal Server Error", "no OTA partition in this firmware");
  if (req->content_len == 0) return fail(req, "400 Bad Request", "empty upload");
  if (req->content_len > part->size) return fail(req, "400 Bad Request", "image larger than OTA partition");

  mf_log("receiving %u bytes into %s", (unsigned)req->content_len, part->label);
  esp_ota_handle_t ota = 0;
  esp_err_t err = esp_ota_begin(part, OTA_WITH_SEQUENTIAL_WRITES, &ota);
  if (err != ESP_OK) return fail(req, "500 Internal Server Error", esp_err_to_name(err));

  const size_t kBuf = 4096;
  char *buf = (char *)malloc(kBuf);
  if (!buf) {
    esp_ota_abort(ota);
    return fail(req, "500 Internal Server Error", "out of memory");
  }
  size_t remaining = req->content_len;
  int timeouts = 0;
  while (remaining > 0) {
    int n = httpd_req_recv(req, buf, remaining < kBuf ? remaining : kBuf);
    if (n == HTTPD_SOCK_ERR_TIMEOUT && ++timeouts < 5) continue;
    if (n <= 0) {
      free(buf);
      esp_ota_abort(ota);
      return fail(req, "400 Bad Request", "upload interrupted");
    }
    timeouts = 0;
    err = esp_ota_write(ota, buf, n);
    if (err != ESP_OK) {
      free(buf);
      esp_ota_abort(ota);
      return fail(req, "400 Bad Request", esp_err_to_name(err));
    }
    remaining -= n;
  }
  free(buf);

  err = esp_ota_end(ota);  // verifies the image (magic, chip type, checksum)
  if (err != ESP_OK) {
    return fail(req, "400 Bad Request",
                err == ESP_ERR_OTA_VALIDATE_FAILED ? "image is not valid for this chip" : esp_err_to_name(err));
  }
  err = esp_ota_set_boot_partition(part);
  if (err != ESP_OK) return fail(req, "500 Internal Server Error", esp_err_to_name(err));

  mf_log("update written to %s, rebooting", part->label);
  httpd_resp_sendstr(req, "OK");
  xTaskCreate(restart_task, "mf_restart", 2048, NULL, 5, NULL);
  return ESP_OK;
}

httpd_handle_t start_server() {
  httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
  cfg.server_port = MOBILE_FLASH_OTA_PORT;
  cfg.ctrl_port = MOBILE_FLASH_OTA_PORT + 24000;  // avoid clashing with a project's own httpd
  cfg.max_uri_handlers = 4;
  cfg.stack_size = 6144;
  cfg.lru_purge_enable = true;
  cfg.recv_wait_timeout = 10;

  httpd_handle_t server = NULL;
  if (httpd_start(&server, &cfg) != ESP_OK) {
    mf_log("could not start server on port %d", MOBILE_FLASH_OTA_PORT);
    return NULL;
  }
  httpd_uri_t root = {"/", HTTP_GET, handle_root, NULL};
  httpd_uri_t info = {"/info", HTTP_GET, handle_info, NULL};
  httpd_uri_t update = {"/update", HTTP_POST, handle_update, NULL};
  httpd_register_uri_handler(server, &root);
  httpd_register_uri_handler(server, &info);
  httpd_register_uri_handler(server, &update);
  return server;
}

uint32_t current_ip() {
  // No interfaces created yet means networking was never started; don't touch it.
  if (esp_netif_get_nr_of_ifs() == 0) return 0;
  static const char *keys[] = {"WIFI_STA_DEF", "ETH_DEF", "WIFI_AP_DEF"};
  for (const char *key : keys) {
    esp_netif_t *netif = esp_netif_get_handle_from_ifkey(key);
    esp_netif_ip_info_t ip;
    if (netif && esp_netif_is_netif_up(netif) && esp_netif_get_ip_info(netif, &ip) == ESP_OK && ip.ip.addr != 0) {
      return ip.ip.addr;
    }
  }
  return 0;
}

void ota_task(void *) {
  vTaskDelay(pdMS_TO_TICKS(1500));
  httpd_handle_t server = NULL;
  uint32_t announced_ip = 0;
  TickType_t last_announce = 0;
  bool marked_valid = false;
  for (;;) {
    uint32_t ip = current_ip();
    if (ip && !server) server = start_server();
    if (server && !marked_valid) {
      // Reaching the network counts as a healthy boot when rollback is enabled.
      esp_ota_mark_app_valid_cancel_rollback();
      marked_valid = true;
    }
    // Announce on change, then every 2 minutes so a late serial monitor still sees it.
    if (server && ip && (ip != announced_ip || xTaskGetTickCount() - last_announce > pdMS_TO_TICKS(120000))) {
      mf_log("ready: http://%u.%u.%u.%u:%d/", (unsigned)(ip & 0xff), (unsigned)((ip >> 8) & 0xff),
             (unsigned)((ip >> 16) & 0xff), (unsigned)(ip >> 24), MOBILE_FLASH_OTA_PORT);
      announced_ip = ip;
      last_announce = xTaskGetTickCount();
    }
    vTaskDelay(pdMS_TO_TICKS(1000));
  }
}

// Runs before setup()/app_main(); the task itself starts once the scheduler does.
__attribute__((constructor)) void mobile_flash_ota_init() {
  xTaskCreate(ota_task, "mf_ota", 4096, NULL, 3, NULL);
}

}  // namespace
