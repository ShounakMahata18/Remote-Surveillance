#pragma once

#define WIFI_SSID "replace-me"
#define WIFI_PASSWORD "replace-me"
#define CAMERA_SECRET "replace-with-the-same-32-byte-secret-used-by-the-relay"
#define CAMERA_WS_HOST "localhost"
#define CAMERA_WS_PORT 3000
#define CAMERA_WS_PATH "/ws"

// Leave empty for local ws:// development. For wss://, pin the relay certificate
// fingerprint and set the matching secure port (usually 443).
#define CAMERA_WS_TLS_FINGERPRINT ""
