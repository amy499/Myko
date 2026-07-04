/*
 * ollama.js
 *
 * What it does:  Local LLM backend via Ollama's REST API. Text-only — no
 *                vision support. Used as brain.js's third fallback (after
 *                OpenAI and Gemini) and as the sole backend when offline
 *                mode is enabled, so conversation/personality calls can run
 *                with nothing leaving the machine.
 *
 * Exports:       chatWithOllama({ system, user, jsonMode, maxTokens }) —
 *                                    async, returns "" on any failure/absence,
 *                                    never throws.
 *                isOllamaConfigured() — sync boolean
 *
 * Env vars:      OLLAMA_ENABLED  — must be "true" to attempt Ollama at all.
 *                                   Opt-in on purpose: without it we'd silently
 *                                   probe localhost:11434 for people who never
 *                                   installed Ollama.
 *                OLLAMA_BASE_URL — default "http://localhost:11434"
 *                OLLAMA_MODEL    — default "llama3.1:8b"
 */

"use strict";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.1:8b";

function isOllamaConfigured() {
  return String(process.env.OLLAMA_ENABLED || "").toLowerCase() === "true";
}

let warnedUnreachable = false;

/*
 * Chat completion via Ollama's /api/chat. Text-only: `imageBase64` in `opts`
 * is intentionally ignored — routing vision through a local model is out of
 * scope here, so vision calls must not reach this function in offline mode.
 */
async function chatWithOllama({ system, user, jsonMode, maxTokens = 400 } = {}) {
  if (!isOllamaConfigured()) return "";

  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user || "" });

  const body = {
    model: OLLAMA_MODEL,
    messages,
    stream: false,
    options: { num_predict: maxTokens, temperature: 0.85 },
  };
  if (jsonMode) body.format = "json";

  let res;
  try {
    res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (!warnedUnreachable) {
      console.warn(
        `[ollama] can't reach ${OLLAMA_BASE_URL} — is \`ollama serve\` running? (${e.message})`
      );
      warnedUnreachable = true;
    }
    return "";
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.warn(
      `[ollama] ${res.status} — is model "${OLLAMA_MODEL}" pulled? (ollama pull ${OLLAMA_MODEL})`,
      errText.slice(0, 160)
    );
    return "";
  }

  const json = await res.json().catch(() => null);
  return (json?.message?.content || "").trim();
}

module.exports = { chatWithOllama, isOllamaConfigured, OLLAMA_MODEL, OLLAMA_BASE_URL };
