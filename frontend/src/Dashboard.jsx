import { useCallback, useEffect, useRef, useState } from "react";

const WS_URL = import.meta.env.VITE_WS_URL || `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
const RESOLUTIONS = [
  ["QQVGA", "QQVGA · 160×120"],
  ["QVGA", "QVGA · 320×240"],
  ["VGA", "VGA · 640×480"],
  ["SVGA", "SVGA · 800×600"],
  ["XGA", "XGA · 1024×768"],
];

function clockText(date) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
  }).format(date);
}

function measureCaptureToDisplayMs(captureTime, displayedAt, cameraOffset, browserOffset) {
  if (
    !Number.isFinite(captureTime) ||
    captureTime <= 0 ||
    !Number.isFinite(displayedAt) ||
    !Number.isFinite(cameraOffset)
  ) {
    return null;
  }
  return Math.max(0, Math.round(displayedAt + browserOffset - (captureTime + cameraOffset)));
}

export default function Dashboard({ token, onLogout }) {
  const imageRef = useRef(null);
  const socketRef = useRef(null);
  const latestBlobRef = useRef(null);
  const frameTimesRef = useRef([]);
  const lastFrameAtRef = useRef(0);
  const browserClockOffsetRef = useRef(0);
  const cameraClockOffsetRef = useRef(null);
  const lastCaptureTimeRef = useRef(0);
  const lastDisplayedAtRef = useRef(0);
  const latestLatencyRef = useRef(null);
  const frameSequenceRef = useRef(0);
  const resolutionTimeoutRef = useRef(null);
  const [connection, setConnection] = useState("connecting");
  const [cameraOnline, setCameraOnline] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  const [streamTimedOut, setStreamTimedOut] = useState(false);
  const [fps, setFps] = useState(0);
  const [lag, setLag] = useState(null);
  const [now, setNow] = useState(new Date());
  const [resolution, setResolution] = useState("VGA");
  const [pendingResolution, setPendingResolution] = useState("");
  const [torch, setTorch] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const clockTimer = window.setInterval(() => setNow(new Date()), 50);
    const telemetryTimer = window.setInterval(() => {
      const currentTime = performance.now();
      frameTimesRef.current = frameTimesRef.current.filter((time) => currentTime - time < 1000);
      setFps(frameTimesRef.current.length);
      if (lastFrameAtRef.current && currentTime - lastFrameAtRef.current >= 5000) {
        lastFrameAtRef.current = 0;
        latestBlobRef.current = null;
        lastCaptureTimeRef.current = 0;
        lastDisplayedAtRef.current = 0;
        latestLatencyRef.current = null;
        frameTimesRef.current = [];
        const canvas = imageRef.current;
        const context = canvas?.getContext("2d");
        if (context && canvas) context.clearRect(0, 0, canvas.width, canvas.height);
        setFps(0);
        setLag(null);
        setHasFrame(false);
        setStreamTimedOut(true);
      } else if (lastFrameAtRef.current) {
        setLag(latestLatencyRef.current);
      }
    }, 500);
    return () => {
      window.clearInterval(clockTimer);
      window.clearInterval(telemetryTimer);
    };
  }, []);

  useEffect(() => {
    let reconnectTimer;
    let disposed = false;

    function connect() {
      if (disposed) return;
      setConnection("connecting");
      const socket = new WebSocket(WS_URL);
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        lastFrameAtRef.current = 0;
        latestBlobRef.current = null;
        latestLatencyRef.current = null;
        setHasFrame(false);
        setStreamTimedOut(false);
        socket.send(JSON.stringify({
          type: "AUTH_VIEWER",
          token,
          clientTime: Date.now(),
          clientPerf: performance.now(),
        }));
      });

      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
          if (event.data.byteLength < 9) return;
          const bytes = new DataView(event.data);
          const captureTime = Number(bytes.getBigUint64(0, false));
          const jpeg = new Blob([event.data.slice(8)], { type: "image/jpeg" });
          latestBlobRef.current = jpeg;

          const sequence = ++frameSequenceRef.current;
          createImageBitmap(jpeg).then((bitmap) => {
            if (sequence !== frameSequenceRef.current) {
              bitmap.close();
              return;
            }
            const canvas = imageRef.current;
            if (canvas) {
              if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
              }
              const context = canvas.getContext("2d");
              if (context) {
                context.drawImage(bitmap, 0, 0);
                const displayedAt = Date.now();
                lastCaptureTimeRef.current = captureTime;
                lastDisplayedAtRef.current = displayedAt;
                latestLatencyRef.current = measureCaptureToDisplayMs(
                  captureTime,
                  displayedAt,
                  cameraClockOffsetRef.current,
                  browserClockOffsetRef.current
                );
                setHasFrame(true);
                setStreamTimedOut(false);
                const renderedAtPerf = performance.now();
                lastFrameAtRef.current = renderedAtPerf;
                frameTimesRef.current.push(renderedAtPerf);
                frameTimesRef.current = frameTimesRef.current.filter((time) => renderedAtPerf - time < 1000);
                setFps(frameTimesRef.current.length);
                setLag(latestLatencyRef.current);
              }
            }
            bitmap.close();
          }).catch(() => {
            setNotice("A camera frame could not be decoded.");
          });

          return;
        }

        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === "AUTH_OK" && message.role === "viewer") {
          const roundTrip = Number.isFinite(message.clientPerf)
            ? performance.now() - message.clientPerf
            : 0;
          if (Number.isFinite(message.serverTime)) {
            browserClockOffsetRef.current = message.serverTime - (Date.now() - roundTrip / 2);
          }
          if (Number.isFinite(message.cameraClockOffsetMs)) {
            cameraClockOffsetRef.current = message.cameraClockOffsetMs;
            latestLatencyRef.current = measureCaptureToDisplayMs(
              lastCaptureTimeRef.current,
              lastDisplayedAtRef.current,
              cameraClockOffsetRef.current,
              browserClockOffsetRef.current
            );
            setLag(latestLatencyRef.current);
          }
          setCameraOnline(Boolean(message.cameraConnected));
          setConnection("connected");
        } else if (message.type === "CLOCK_SYNC") {
          if (Number.isFinite(message.cameraClockOffsetMs)) {
            cameraClockOffsetRef.current = message.cameraClockOffsetMs;
            latestLatencyRef.current = measureCaptureToDisplayMs(
              lastCaptureTimeRef.current,
              lastDisplayedAtRef.current,
              cameraClockOffsetRef.current,
              browserClockOffsetRef.current
            );
            setLag(latestLatencyRef.current);
          }
        } else if (message.type === "STATUS") {
          if (message.status === "camera_connected") setCameraOnline(true);
          if (message.status === "camera_disconnected") setCameraOnline(false);
          if (message.value === "torch_on") setTorch(true);
          if (message.value === "torch_off") setTorch(false);
          if (message.value === "resolution_change_failed") {
            window.clearTimeout(resolutionTimeoutRef.current);
            setPendingResolution("");
            setNotice("The camera could not switch resolution.");
          }
        } else if (message.type === "RESOLUTION_ACK") {
          window.clearTimeout(resolutionTimeoutRef.current);
          setResolution(message.value);
          setPendingResolution("");
          setNotice(`Sensor set to ${message.value}.`);
        } else if (message.type === "ERROR") {
          window.clearTimeout(resolutionTimeoutRef.current);
          setPendingResolution("");
          setNotice(message.error);
        } else if (message.type === "AUTH_ERROR") {
          onLogout();
        }
      });

      socket.addEventListener("close", (event) => {
        setConnection("disconnected");
        if (event.code === 4001 || event.code === 4003) {
          onLogout();
          return;
        }
        if (!disposed) reconnectTimer = window.setTimeout(connect, 2000);
      });
      socket.addEventListener("error", () => setConnection("disconnected"));
    }

    connect();
    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimer);
      socketRef.current?.close();
      frameSequenceRef.current += 1;
      window.clearTimeout(resolutionTimeoutRef.current);
    };
  }, [token, onLogout]);

  const sendCommand = useCallback((command) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setNotice("The relay is not connected.");
      return false;
    }
    socket.send(JSON.stringify(command));
    return true;
  }, []);

  function changeResolution(event) {
    const value = event.target.value;
    setPendingResolution(value);
    setNotice("");
    if (!sendCommand({ type: "SET_RESOLUTION", value })) {
      setPendingResolution("");
      return;
    }
    window.clearTimeout(resolutionTimeoutRef.current);
    resolutionTimeoutRef.current = window.setTimeout(() => {
      setPendingResolution("");
      setNotice("No resolution acknowledgment received.");
    }, 10000);
  }

  function toggleTorch() {
    const next = !torch;
    if (sendCommand({ type: "SET_TORCH", value: next })) setTorch(next);
  }

  function saveSnapshot() {
    const blob = latestBlobRef.current;
    if (!blob) {
      setNotice("No frame is available to capture yet.");
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `camera-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <main className="h-[100dvh] overflow-hidden px-3 py-3 text-slate-100 sm:px-8 sm:py-5">
      <div className="mx-auto flex h-full w-full max-w-7xl flex-col">
        <header className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">Remote surveillance</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Live camera</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs ${connection === "connected" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-amber-500/30 bg-amber-500/10 text-amber-200"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${connection === "connected" ? "bg-emerald-400" : "bg-amber-300"}`} />
              Relay {connection}
            </span>
            <button onClick={onLogout} className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800">Log out</button>
          </div>
        </header>

        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-xl shadow-black/20 lg:flex-row">
          <div className="relative order-1 flex min-h-0 flex-1 items-center justify-center bg-black lg:order-2">
            <canvas ref={imageRef} role="img" aria-label="Live camera stream" className="absolute inset-0 h-full w-full object-contain" />
            {!hasFrame && (
              <div className="z-10 rounded-xl border border-slate-700 bg-slate-950/90 px-5 py-4 text-center">
                <p className="font-medium text-slate-200">
                  {streamTimedOut
                    ? "No video frames for 5 seconds"
                    : !cameraOnline
                      ? `Camera ${connection === "connected" ? "offline" : "connecting"}`
                      : "Camera connected; waiting for video"}
                </p>
                <p className="mt-1 text-sm text-slate-400">
                  {streamTimedOut
                    ? "Waiting for the camera to reconnect. The live view will resume automatically."
                    : !cameraOnline
                      ? "The relay is waiting for the ESP32-CAM publisher."
                      : "Check the camera Serial Monitor for “Frame sent” messages."}
                </p>
              </div>
            )}
            <div className="absolute inset-x-0 top-0 z-20 flex flex-wrap items-start justify-between gap-3 bg-gradient-to-b from-black/80 to-transparent p-3 sm:p-5">
              <div className="rounded-md bg-black/50 px-3 py-2 font-mono text-xs text-white sm:text-sm">
                <div>{now.toLocaleDateString()}</div>
                <div>{clockText(now)}</div>
              </div>
              <div className="flex gap-2">
                <Telemetry label="CAPTURE → DISPLAY" value={lag === null ? "--" : `${lag} ms`} />
                <Telemetry label="RENDERED FPS" value={fps} />
              </div>
            </div>
            <div className="absolute bottom-3 left-3 z-20 flex items-center gap-2 rounded-full bg-black/60 px-3 py-1.5 text-xs">
              <span className={`h-2 w-2 rounded-full ${cameraOnline && hasFrame ? "animate-pulse bg-red-500" : "bg-slate-500"}`} />
              {cameraOnline && hasFrame ? "LIVE" : cameraOnline ? "WAITING FOR VIDEO" : "NO SIGNAL"}
            </div>
          </div>

          <div className="order-2 grid shrink-0 gap-3 border-t border-slate-800 p-3 sm:grid-cols-[1fr_auto] sm:items-end sm:gap-5 sm:p-4 lg:order-1 lg:w-64 lg:flex lg:flex-col lg:items-stretch lg:justify-start lg:gap-6 lg:border-r lg:border-t-0 lg:p-5">
            <p className="hidden text-xs font-semibold uppercase tracking-[0.18em] text-slate-400 lg:block">Camera controls</p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
              <label className="block text-sm font-medium text-slate-300">
                Sensor resolution
                <select
                  value={pendingResolution || resolution}
                  onChange={changeResolution}
                  disabled={!cameraOnline || Boolean(pendingResolution)}
                  className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white disabled:opacity-50"
                >
                  {RESOLUTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                </select>
                {pendingResolution && <span className="mt-1 block text-xs text-cyan-300">Switching sensor to {pendingResolution}…</span>}
              </label>
              <div className="flex flex-wrap items-end gap-2">
                <button onClick={toggleTorch} disabled={!cameraOnline} className={`rounded-lg border px-4 py-2.5 text-sm font-medium disabled:opacity-50 ${torch ? "border-amber-400/50 bg-amber-400/10 text-amber-200" : "border-slate-700 text-slate-200 hover:bg-slate-800"}`}>
                  {torch ? "Torch on" : "Torch off"}
                </button>
                <button onClick={saveSnapshot} className="rounded-lg border border-slate-700 px-4 py-2.5 text-sm font-medium text-slate-200 hover:bg-slate-800">
                  Save snapshot
                </button>
              </div>
            </div>
            {notice && <p role="status" className="text-sm text-slate-400 sm:col-span-2 lg:col-span-1">{notice}</p>}
          </div>
        </section>
        <p className="mt-2 shrink-0 truncate text-[10px] text-slate-500 sm:text-xs">Capture-to-display latency uses synchronized monotonic clocks and refreshes every 0.5 seconds. FPS is measured over a rolling one-second window.</p>
      </div>
    </main>
  );
}

function Telemetry({ label, value }) {
  return (
    <div className="rounded-md border border-white/10 bg-black/60 px-2.5 py-1.5 text-right sm:px-3">
      <div className="text-[9px] font-semibold tracking-wider text-slate-400 sm:text-[10px]">{label}</div>
      <div className="font-mono text-xs font-medium text-white sm:text-sm">{value}</div>
    </div>
  );
}
