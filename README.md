# Remote Surveillance

An ESP32-CAM streams timestamped JPEG packets over an outbound WebSocket to a Node.js relay. Authorized browsers authenticate with the relay and receive frames without router port forwarding, a static IP, or DDNS. Do not expose the camera secret or whitelist password hashes publicly.

## Components

- `firmware/RemoteSurveillanceCam/`: Arduino IDE sketch for the AI Thinker ESP32-CAM / OV2640.
- `server/`: Express login API and authenticated `ws` relay.
- `frontend/`: React + Tailwind responsive login and live-monitor dashboard.

## Run locally

1. Install Node.js 20 or newer. From the project root run `npm install --prefix server` and `npm install --prefix frontend`.
2. Copy `server/.env.example` to `server/.env`. Replace both secrets with independent random values of at least 32 bytes. For example, generate each with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Set `WEB_ORIGIN=http://localhost:5173`.
3. Add an allowed account to `server/users.json` as described below.
4. Start the relay with `npm run dev:server`, then start the dashboard in another terminal with `npm run dev:frontend`. Open the Vite URL, normally `http://localhost:5173`.
5. Configure and flash the camera firmware. It makes an outbound connection to the relay; no inbound router ports are needed.

For a single-host deployment, build the frontend with `npm run build`; the relay serves `frontend/dist` when that directory exists. For separate hosting, set `VITE_API_URL` and `VITE_WS_URL` at frontend build time and set the relay `WEB_ORIGIN` to the exact dashboard origin. Use HTTPS/WSS in production.

When running behind a single trusted reverse proxy (as with a typical hosted web service), set `TRUST_PROXY=1` so login rate limits use the client IP forwarded by that proxy. Leave it disabled when the Node server is directly exposed or when the proxy chain is not controlled.

## Whitelist accounts

Passwords are stored as bcrypt hashes, not plaintext. Generate one interactively (so the password is not written into shell history):

```sh
node -e "const readline=require('node:readline/promises'); const bcrypt=require('./server/node_modules/bcryptjs'); (async()=>{const r=readline.createInterface({input:process.stdin,output:process.stdout}); const p=await r.question('Password: '); console.log(await bcrypt.hash(p,12)); r.close();})();"
```

Add the result to `server/users.json`:

```json
[
  {
    "username": "operator",
    "passwordHash": "$2b$12$REPLACE_WITH_THE_GENERATED_BCRYPT_HASH"
  }
]
```

The login API rate-limits attempts and returns a short-lived signed JWT. Passwords and tokens are never put in WebSocket URLs. The browser sends the JWT as the first WebSocket message; the relay closes clients that fail authentication and does not forward data before authentication. Protect `users.json`, `.env`, and `firmware/RemoteSurveillanceCam/secrets.h` with appropriate filesystem access controls.

## Firmware configuration and flashing

1. Install Arduino IDE 2.x. In Boards Manager, install **esp32 by Espressif Systems**; Arduino-ESP32 2.0.14 is the version used to validate this sketch. Select **AI Thinker ESP32-CAM** and enable **PSRAM** from the Tools menu.
2. In Library Manager, install **WebSockets by Markus Sattler** and **ArduinoJson by Benoit Blanchon**. `WiFi`, `esp_camera`, and the other ESP32 headers come from the Espressif board package.
3. Open `firmware/RemoteSurveillanceCam/RemoteSurveillanceCam.ino` in Arduino IDE. Copy `secrets.example.h` in that same folder to `secrets.h`; set Wi-Fi credentials, relay hostname/port, and the same `CAMERA_SECRET` as the Node server. Keep `secrets.h` private.
4. For Render WSS, use the provider's trusted root CA certificate in `CAMERA_WS_CA_CERT` and port 443. The current Render endpoint certificate chain is issued by Google Trust Services; use its official GTS Root R4 PEM certificate from `https://pki.goog/repo/certs/gtsr4.pem`. Paste it into a C++ string macro in `secrets.h`, escaping each line ending as `\n`. Do not pin the short-lived leaf certificate fingerprint. Local development uses an empty `CAMERA_WS_CA_CERT`, `ws://`, and port 3000.
5. Connect an FTDI/USB-to-serial adapter at 3.3 V logic. Power the AI Thinker board from a stable regulated 5 V supply; connect GND, TX-to-U0R, RX-to-U0T, and pull GPIO0 low. Click **Upload** in Arduino IDE. Return GPIO0 high and reset to run; use Serial Monitor at 115200 baud.
6. The OV2640 initializes at VGA, JPEG quality 12, 20 MHz XCLK, two PSRAM frame buffers, and `CAMERA_GRAB_LATEST`. Dashboard commands switch the sensor directly to QQVGA, QVGA, VGA, SVGA, or XGA.

## Latency and telemetry

Each binary WebSocket frame begins with an unsigned 8-byte big-endian ESP32 monotonic capture-start time in milliseconds, followed by JPEG bytes. NTP is not required. On publisher connect, the relay and camera exchange four timestamps to estimate the offset between the ESP32 uptime clock and relay time. On viewer authentication, the browser estimates its relay-clock offset using the request/response midpoint. Capture-to-display latency is calculated when a frame is drawn and refreshed in the HUD every 0.5 seconds; network asymmetry and browser scheduling still make this an estimate. If no frame arrives for 5 seconds, the canvas clears to black and shows a reconnect message; it resumes automatically when frames return. FPS counts frames received and rendered in a rolling one-second window.

## Operations and troubleshooting

- `GET /health` reports relay health, publisher presence, connected viewers, and server time. Never use it to expose secrets.
- Verify the relay is reachable over outbound TCP from the camera network. Cloud firewalls and Wi-Fi client isolation can block that connection.
- Brownouts, repeated camera resets, or Wi-Fi drops usually indicate insufficient power. Use a short, low-resistance 5 V lead and a supply rated for at least 1 A; avoid powering the camera from a weak USB-serial adapter.
- If FPS is low, start with QVGA or VGA, ensure PSRAM is enabled, keep Wi-Fi power save disabled, and check RSSI and relay uplink capacity. Higher resolution and image detail increase capture time and bandwidth.
- If the stream is blank, check the board pin mapping, camera ribbon orientation, matching camera secrets, Serial Monitor frame logs, and relay logs. Camera connections are outbound; router port forwarding is not required.
- Flash GPIO4 can be bright and hot. Use it briefly and ensure the hardware is appropriate for the environment.

For production, terminate TLS at the hosting platform, set strict origins, rotate secrets, back up the whitelist securely, and monitor relay logs and resource use.
