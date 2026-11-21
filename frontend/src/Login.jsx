import { useState } from "react";

const API_BASE = import.meta.env.VITE_API_URL || "";

export default function Login({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const response = await fetch(`${API_BASE}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Sign-in failed.");
      onLogin(result.token);
    } catch (requestError) {
      setError(requestError.message || "Unable to reach the relay.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10 text-slate-100">
      <section className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/80 p-8 shadow-2xl shadow-black/30">
        <div className="mb-8">
          <div className="mb-5 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-cyan-400/10 text-cyan-300">
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M3 7.5h3l1.5-2h9l1.5 2h3v11H3z" />
              <circle cx="12" cy="13" r="3.5" />
            </svg>
          </div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-cyan-300">Private camera</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Sign in to monitor</h1>
          <p className="mt-2 text-sm text-slate-400">Use an account configured on the relay server.</p>
        </div>

        <form className="space-y-5" onSubmit={submit}>
          <label className="block text-sm font-medium text-slate-300">
            Username
            <input
              autoComplete="username"
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-3 text-white outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/20"
            />
          </label>
          <label className="block text-sm font-medium text-slate-300">
            Password
            <input
              autoComplete="current-password"
              required
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-3 text-white outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/20"
            />
          </label>
          {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
          <button
            disabled={busy}
            className="w-full rounded-lg bg-cyan-400 px-4 py-3 font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-wait disabled:opacity-60"
          >
            {busy ? "Verifying..." : "Sign in"}
          </button>
        </form>
        <p className="mt-6 text-center text-xs text-slate-500">Authorized users only</p>
      </section>
    </main>
  );
}
