#!/usr/bin/env node
// Diagnose LLM credential resolution and make a tiny live call.
//   node bin/llm-check.js
import { describe, isConfigured, complete } from "../src/llm.js";

const info = describe();
if (!info) {
  console.log("no LLM configured.");
  console.log("checked (in order): ~/.config/instapy/llm.json, app/llm.local.json, env keys");
  console.log("(ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY), gcloud ADC, oauth-token file");
  console.log("see app/llm.example.json — API keys or OAuth both work");
  process.exit(0);
}

console.log("resolved:", JSON.stringify(info));
try {
  const reply = await complete("Reply with exactly the word: ready", { maxTokens: 8 });
  console.log("LLM replied:", JSON.stringify(reply));
  console.log("escalation layer is live");
} catch (e) {
  console.error("LLM call failed:", e.message);
  process.exit(1);
}
