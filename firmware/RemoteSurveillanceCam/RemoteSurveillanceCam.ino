#include <Arduino.h>
#include <ArduinoJson.h>
#include <WebSocketsClient.h>
#include <WiFi.h>
#include <esp_camera.h>
#include <esp_timer.h>

// Copy secrets.example.h to secrets.h and configure it before uploading.
#include "secrets.h"

#ifndef CAMERA_WS_HOST
#error "Define CAMERA_WS_HOST in secrets.h"
#endif
#ifndef CAMERA_WS_PORT
#error "Define CAMERA_WS_PORT in secrets.h"
#endif
#ifndef CAMERA_WS_PATH
#define CAMERA_WS_PATH "/ws"
#endif
#ifndef CAMERA_WS_TLS_FINGERPRINT
#define CAMERA_WS_TLS_FINGERPRINT ""
#endif

// AI Thinker ESP32-CAM pin mapping.
#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22

static const uint8_t FLASH_LED_GPIO = 4;
static const uint32_t WIFI_RETRY_INTERVAL_MS = 10000;
static const uint32_t FRAME_INTERVAL_MS = 1;
static const uint32_t MAX_JPEG_BYTES = 2 * 1024 * 1024;
static const uint32_t FRAME_LOG_INTERVAL_MS = 5000;

WebSocketsClient webSocket;
uint32_t lastWifiAttempt = 0;
uint32_t lastFrameAttempt = 0;
uint32_t lastFrameLog = 0;
bool torchEnabled = false;
bool useTls = false;

framesize_t frameSizeFor(const char *name) {
  if (strcmp(name, "QQVGA") == 0) return FRAMESIZE_QQVGA;
  if (strcmp(name, "QVGA") == 0) return FRAMESIZE_QVGA;
  if (strcmp(name, "VGA") == 0) return FRAMESIZE_VGA;
  if (strcmp(name, "SVGA") == 0) return FRAMESIZE_SVGA;
  if (strcmp(name, "XGA") == 0) return FRAMESIZE_XGA;
  return FRAMESIZE_INVALID;
}

const char *frameSizeName(framesize_t size) {
  switch (size) {
    case FRAMESIZE_QQVGA: return "QQVGA";
    case FRAMESIZE_QVGA: return "QVGA";
    case FRAMESIZE_VGA: return "VGA";
    case FRAMESIZE_SVGA: return "SVGA";
    case FRAMESIZE_XGA: return "XGA";
    default: return "UNKNOWN";
  }
}

bool initializeCamera() {
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAMESIZE_VGA;
  config.jpeg_quality = 12;
  config.fb_count = 2;
  config.grab_mode = CAMERA_GRAB_LATEST;
  config.fb_location = CAMERA_FB_IN_PSRAM;

  const esp_err_t result = esp_camera_init(&config);
  if (result != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", result);
    return false;
  }

  sensor_t *sensor = esp_camera_sensor_get();
  if (sensor == nullptr) {
    Serial.println("Camera sensor handle unavailable.");
    return false;
  }
  sensor->set_framesize(sensor, FRAMESIZE_VGA);
  sensor->set_quality(sensor, 12);
  sensor->set_brightness(sensor, 0);
  sensor->set_contrast(sensor, 0);
  sensor->set_saturation(sensor, 0);
  sensor->set_vflip(sensor, 0);
  sensor->set_hmirror(sensor, 0);
  return true;
}

uint64_t monotonicMilliseconds() {
  const int64_t timeUs = esp_timer_get_time();
  return timeUs > 0 ? static_cast<uint64_t>(timeUs / 1000) : 0;
}

void sendStatus(const char *type, const char *value) {
  JsonDocument message;
  message["type"] = type;
  message["value"] = value;
  String payload;
  serializeJson(message, payload);
  webSocket.sendTXT(payload);
}

void handleControl(const JsonDocument &message) {
  const char *type = message["type"] | "";
  if (strcmp(type, "SET_RESOLUTION") == 0) {
    const char *value = message["value"] | "";
    const framesize_t requestedSize = frameSizeFor(value);
    sensor_t *sensor = esp_camera_sensor_get();
    if (requestedSize == FRAMESIZE_INVALID || sensor == nullptr) {
      sendStatus("STATUS", "resolution_change_failed");
      return;
    }
    const int result = sensor->set_framesize(sensor, requestedSize);
    if (result != 0) {
      sendStatus("STATUS", "resolution_change_failed");
      return;
    }
    JsonDocument ack;
    ack["type"] = "RESOLUTION_ACK";
    ack["value"] = frameSizeName(requestedSize);
    String payload;
    serializeJson(ack, payload);
    webSocket.sendTXT(payload);
    return;
  }

  if (strcmp(type, "SET_TORCH") == 0 && message["value"].is<bool>()) {
    torchEnabled = message["value"].as<bool>();
    digitalWrite(FLASH_LED_GPIO, torchEnabled ? HIGH : LOW);
    sendStatus("STATUS", torchEnabled ? "torch_on" : "torch_off");
    return;
  }

  if (strcmp(type, "TIME_SYNC") == 0) {
    const uint64_t deviceReceiveMs = monotonicMilliseconds();
    const uint64_t deviceSendMs = monotonicMilliseconds();
    JsonDocument reply;
    reply["type"] = "TIME_SYNC";
    reply["id"] = message["id"];
    reply["deviceReceiveMs"] = deviceReceiveMs;
    reply["deviceSendMs"] = deviceSendMs;
    String payload;
    serializeJson(reply, payload);
    webSocket.sendTXT(payload);
  }
}

void onWebSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED: {
      JsonDocument auth;
      auth["type"] = "AUTH_PUBLISHER";
      auth["secret"] = CAMERA_SECRET;
      String message;
      serializeJson(auth, message);
      webSocket.sendTXT(message);
      Serial.println("WebSocket connected; publisher authentication sent.");
      break;
    }
    case WStype_DISCONNECTED:
      Serial.println("WebSocket disconnected; reconnecting automatically.");
      break;
    case WStype_TEXT: {
      JsonDocument message;
      const DeserializationError error = deserializeJson(message, payload, length);
      if (error) {
        Serial.printf("Control JSON error: %s\n", error.c_str());
        break;
      }
      if (strcmp(message["type"] | "", "AUTH_OK") == 0) {
        Serial.println("Publisher authenticated.");
      }
      handleControl(message);
      break;
    }
    case WStype_ERROR:
      Serial.println("WebSocket transport error.");
      break;
    default:
      break;
  }
}

void connectWebSocket() {
  webSocket.onEvent(onWebSocketEvent);
  webSocket.setReconnectInterval(5000);
  webSocket.enableHeartbeat(15000, 3000, 2);
  if (useTls) {
    webSocket.beginSSL(
        CAMERA_WS_HOST,
        CAMERA_WS_PORT,
        CAMERA_WS_PATH,
        CAMERA_WS_TLS_FINGERPRINT
    );
  } else {
    webSocket.begin(CAMERA_WS_HOST, CAMERA_WS_PORT, CAMERA_WS_PATH);
  }
}

void captureAndSendFrame() {
  if (webSocket.isConnected() == false) return;
  const uint32_t now = millis();
  if (now - lastFrameAttempt < FRAME_INTERVAL_MS) return;
  lastFrameAttempt = now;

  const uint64_t timestamp = monotonicMilliseconds();
  camera_fb_t *frame = esp_camera_fb_get();
  if (frame == nullptr) return;
  if (frame->format != PIXFORMAT_JPEG || frame->len > MAX_JPEG_BYTES) {
    esp_camera_fb_return(frame);
    return;
  }

  const size_t frameLength = frame->len;
  uint8_t *packet = static_cast<uint8_t *>(ps_malloc(frame->len + 8));
  if (packet == nullptr) {
    Serial.println("Unable to allocate PSRAM for frame packet.");
    esp_camera_fb_return(frame);
    return;
  }
  for (int i = 7; i >= 0; --i) {
    packet[i] = static_cast<uint8_t>(timestamp >> ((7 - i) * 8));
  }
  memcpy(packet + 8, frame->buf, frame->len);
  webSocket.sendBIN(packet, frame->len + 8);
  free(packet);
  esp_camera_fb_return(frame);
  if (millis() - lastFrameLog >= FRAME_LOG_INTERVAL_MS) {
    lastFrameLog = millis();
    Serial.printf("Frame sent: %u bytes; capture uptime %llu ms\n",
                  static_cast<unsigned int>(frameLength),
                  static_cast<unsigned long long>(timestamp));
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(FLASH_LED_GPIO, OUTPUT);
  digitalWrite(FLASH_LED_GPIO, LOW);

  if (!psramFound()) {
    Serial.println("PSRAM is required for VGA double-buffered streaming.");
    while (true) delay(1000);
  }
  if (!initializeCamera()) {
    while (true) delay(1000);
  }

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.println("Connecting to Wi-Fi...");

  const uint32_t waitStart = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - waitStart < 20000) {
    delay(250);
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("Wi-Fi connected: %s\n", WiFi.localIP().toString().c_str());
  }

  useTls = CAMERA_WS_TLS_FINGERPRINT[0] != '\0';
  connectWebSocket();
}

void loop() {
  webSocket.loop();

  if (WiFi.status() != WL_CONNECTED) {
    const uint32_t now = millis();
    if (now - lastWifiAttempt >= WIFI_RETRY_INTERVAL_MS) {
      lastWifiAttempt = now;
      Serial.println("Wi-Fi unavailable; retrying.");
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }
    delay(10);
    return;
  }

  captureAndSendFrame();
  delay(1);
}
