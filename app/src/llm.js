// LLM escalation client with configurable credentials.
//
// Configuration sources, in order:
//   1. ~/.config/instapy/llm.json   (user-level; see llm.example.json)
//   2. app/llm.local.json           (project-level, gitignored)
//   3. environment variables        (provider inferred from which key exists)
//
// Auth modes:
//   api-key       key from env / inline / file config (default)
//   oauth-adc     Google Application Default Credentials; refreshes via the
//                 standard OAuth refresh_token flow (no keys, use `gcloud auth
//                 application-default login`)
//   oauth-token   static bearer token from a JSON file {"access_token": "..."}
//                 (works for Anthropic OAuth tokens and similar providers)
//   none          no auth header (local runtimes: Ollama, LM Studio)
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { record } from "./memory.js";

const CONFIG_FILES = [
  path.join(os.homedir(), ".config", "instapy", "llm.json"),
  fileURLToPath(new URL("../llm.local.json", import.meta.url)),
];

const PROVIDER_DEFAULTS = {
  anthropic: {
    baseURL: "https://api.anthropic.com/v1",
    model: "claude-3-5-haiku-latest",
    envVar: "ANTHROPIC_API_KEY",
  },
  openai: {
    baseURL: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    envVar: "OPENAI_API_KEY",
  },
  gemini: {
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.0-flash",
    envVar: "GEMINI_API_KEY",
  },
};

let singleton = undefined; // undefined = not resolved yet, null = no config

function envKey(name) {
  return name && process.env[name] ? process.env[name].trim() : null;
}

function resolveAuth(cfg, provider) {
  const auth = cfg.auth ?? { mode: "api-key" };
  const dflt = PROVIDER_DEFAULTS[provider] ?? {};
  const mode = auth.mode ?? "api-key";

  if (mode === "none") return { mode: "none" };

  if (mode === "oauth-adc") {
    const adcFile = auth.adcFile
      ? auth.adcFile.replace(/^~(?=$|\/)/, os.homedir())
      : path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json");
    if (!existsSync(adcFile)) return null;
    return { mode: "oauth-adc", adcFile };
  }

  if (mode === "oauth-token") {
    if (!auth.tokenFile) return null;
    const tokenFile = auth.tokenFile.replace(/^~(?=$|\/)/, os.homedir());
    if (!existsSync(tokenFile)) return null;
    return { mode: "oauth-token", tokenFile };
  }

  // api-key
  const key = envKey(auth.envVar ?? dflt.envVar) ?? auth.apiKey ?? null;
  if (!key) return null;
  return { mode: "api-key", key };
}

function resolveConfig() {
  let fileCfg = null;
  for (const f of CONFIG_FILES) {
    if (existsSync(f)) {
      try {
        fileCfg = JSON.parse(readFileSync(f, "utf8"));
        break;
      } catch {
        record({ type: "error", stage: "llm-config", message: `unparseable llm config: ${f}` });
      }
    }
  }

  const explicit = fileCfg?.provider ? fileCfg : null;
  if (explicit) {
    const auth = resolveAuth(explicit, explicit.provider);
    if (!auth) return null;
    return {
      provider: explicit.provider,
      model: explicit.model ?? PROVIDER_DEFAULTS[explicit.provider]?.model,
      baseURL: explicit.baseURL ?? PROVIDER_DEFAULTS[explicit.provider]?.baseURL,
      auth,
    };
  }

  // Infer provider from whichever standard env key is present.
  for (const [provider, d] of Object.entries(PROVIDER_DEFAULTS)) {
    if (envKey(d.envVar)) {
      return {
        provider,
        model: fileCfg?.model ?? d.model,
        baseURL: fileCfg?.baseURL ?? d.baseURL,
        auth: { mode: "api-key", key: envKey(d.envVar) },
      };
    }
  }
  return null;
}

export function isConfigured() {
  if (singleton === undefined) singleton = resolveConfig();
  return singleton !== null;
}

export function describe() {
  const cfg = singleton === undefined ? resolveConfig() : singleton;
  if (!cfg) return null;
  return {
    provider: cfg.provider,
    model: cfg.model,
    baseURL: cfg.baseURL,
    authMode: cfg.auth.mode,
    // never expose the key material itself
    source:
      cfg.auth.mode === "api-key"
        ? cfg.auth.key
          ? "resolved"
          : "missing"
        : cfg.auth.mode,
  };
}

async function bearerToken(auth) {
  if (auth.mode === "oauth-adc") {
    // Refresh and cache; sessions are short so an in-process cache suffices.
    if (cached?.expiresAt > Date.now() + 60_000) return cached.accessToken;
    const adc = JSON.parse(readFileSync(auth.adcFile, "utf8"));
    const res = await fetch(adc.token_uri ?? "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: adc.refresh_token,
        client_id: adc.client_id,
        client_secret: adc.client_secret,
      }),
    });
    if (!res.ok) throw new Error(`ADC token refresh failed: HTTP ${res.status}`);
    const data = await res.json();
    cached = { accessToken: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
    return cached.accessToken;
  }
  if (auth.mode === "oauth-token") {
    const data = JSON.parse(readFileSync(auth.tokenFile, "utf8"));
    return data.access_token;
  }
  return null;
}

let cached = null; // ADC token cache { accessToken, expiresAt }

async function callLLM({ system, user, maxTokens = 300 }) {
  const cfg = singleton === undefined ? resolveConfig() : singleton;
  if (!cfg) throw new Error("no LLM configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000); // local models can cold-load
  try {
    if (cfg.provider === "anthropic") {
      const headers = {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      };
      if (cfg.auth.mode === "api-key") headers["x-api-key"] = cfg.auth.key;
      else headers.Authorization = `Bearer ${await bearerToken(cfg.auth)}`;
      const res = await fetch(`${cfg.baseURL}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: maxTokens,
          ...(system ? { system } : {}),
          messages: [{ role: "user", content: user }],
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      return (data.content ?? []).map((c) => c.text ?? "").join("").trim();
    }

    if (cfg.provider === "gemini") {
      let url = `${cfg.baseURL}/models/${cfg.model}:generateContent`;
      const headers = { "Content-Type": "application/json" };
      if (cfg.auth.mode === "api-key") url += `?key=${encodeURIComponent(cfg.auth.key)}`;
      else headers.Authorization = `Bearer ${await bearerToken(cfg.auth)}`;
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          contents: [{ parts: [{ text: system ? `${system}\n\n${user}` : user }] }],
          generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 },
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      return (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
    }

    // openai + openai-compatible (Ollama, LM Studio, Z.ai, Groq, …)
    const headers = { "Content-Type": "application/json" };
    if (cfg.auth.mode !== "none") {
      const token = cfg.auth.mode === "api-key" ? cfg.auth.key : await bearerToken(cfg.auth);
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(`${cfg.baseURL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: maxTokens,
        temperature: 0.2,
        messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: user }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${cfg.provider} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return (data.choices?.[0]?.message?.content ?? "").trim();
  } finally {
    clearTimeout(timer);
  }
}

export async function complete(prompt, { system, maxTokens } = {}) {
  return callLLM({ user: prompt, system, maxTokens });
}

// Ask for a JSON verdict and parse leniently (models sometimes wrap in prose
// or reasoning blocks like <think>...</think>).
export async function askJSON(system, user, { maxTokens } = {}) {
  const text = await callLLM({
    system: `${system}\nRespond with a single JSON object and nothing else.`,
    user,
    maxTokens,
  });
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`no JSON in LLM reply: ${text.slice(0, 200)}`);
  return JSON.parse(match[0]);
}
