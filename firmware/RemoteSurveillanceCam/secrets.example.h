#pragma once

#define WIFI_SSID "replace-me"
#define WIFI_PASSWORD "replace-me"
#define CAMERA_SECRET "replace-with-the-same-32-byte-secret-used-by-the-relay"
#define CAMERA_WS_HOST "localhost"
#define CAMERA_WS_PORT 3000
#define CAMERA_WS_PATH "/ws"

// Leave empty for local ws:// development. For Render, paste the PEM root CA
// certificate here and use port 443. Do not use a leaf fingerprint.
#define CAMERA_WS_CA_CERT ""
