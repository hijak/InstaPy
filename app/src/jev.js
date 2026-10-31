// Jev (System One) client. Typed decisions in, calibrated probabilities out.
// The key comes from TYPESAFE_API_KEY or ~/.config/typesafe/key.
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

function apiKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY.trim();
  const file = path.join(os.homedir(), ".config", "typesafe", "key");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  throw new Error("no TYPESAFE_API_KEY env var and no ~/.config/typesafe/key file");
}

async function post(body, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// questions: { id: { type: "choice"|"score"|"noul", instructions, criteria? } }
export async function ask(state, questions, { model = "jev-latest" } = {}) {
  return post({ model, state, questions });
}

export function choiceAnswer(resp, id) {
  const a = resp.answers?.[id];
  if (!a) throw new Error(`missing Jev choice answer for "${id}"`);
  return { choice: a.choice, confidence: a.confidence, probabilities: a.probabilities ?? {} };
}

export function noulAnswer(resp, id) {
  const a = resp.answers?.[id];
  if (!a) throw new Error(`missing Jev noul answer for "${id}"`);
  return { noul: a.noul };
}
