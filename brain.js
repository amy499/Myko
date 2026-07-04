const fs = require("fs/promises");
const path = require("path");
const { chatWithOllama, isOllamaConfigured } = require("./ollama");

const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini";
const VISION_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";
const OPENAI_BASE = "https://api.openai.com/v1";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// Per-provider quota/backoff. A 429 from one provider freezes only that one;
// the dispatcher then transparently routes to the other so the cat keeps talking.
let openaiBlockedUntil = 0;
let geminiBlockedUntil = 0;
function isOpenaiBlocked() { return Date.now() < openaiBlockedUntil; }
function isGeminiBlocked() { return Date.now() < geminiBlockedUntil; }
function noteOpenaiRateLimit(detail) {
  openaiBlockedUntil = Date.now() + 60 * 60 * 1000;
  console.warn("[brain] OpenAI rate-limit — backing off 60 min", detail || "");
}
function noteGeminiRateLimit(detail) {
  geminiBlockedUntil = Date.now() + 60 * 60 * 1000;
  console.warn("[brain] Gemini rate-limit — backing off 60 min", detail || "");
}
// Back-compat sentinel for older code paths: only "blocked" if BOTH are out.
// Used by the vision-only functions (Ollama has no vision path here).
function isQuotaBlocked() {
  const openOut = isOpenaiBlocked() || !process.env.OPENAI_API_KEY;
  const gemOut  = isGeminiBlocked() || !process.env.GEMINI_API_KEY;
  return openOut && gemOut;
}

// Same idea for text-only calls (getCatResponse, replyToUser), which can also
// be served by Ollama — so those aren't "blocked" just because cloud keys are
// missing/rate-limited, as long as Ollama is configured. In offline mode, the
// only available backend is Ollama, so blocked <=> Ollama isn't configured.
function isTextBlocked(offlineMode) {
  if (offlineMode) return !isOllamaConfigured();
  return isQuotaBlocked() && !isOllamaConfigured();
}

let openaiKeyMissingLogged = false;
let geminiKeyMissingLogged = false;
function hasOpenaiKey() {
  if (!process.env.OPENAI_API_KEY) {
    if (!openaiKeyMissingLogged) {
      console.warn("[brain] OPENAI_API_KEY is not set");
      openaiKeyMissingLogged = true;
    }
    return false;
  }
  return true;
}
function hasGeminiKey() {
  if (!process.env.GEMINI_API_KEY) {
    if (!geminiKeyMissingLogged) {
      console.warn("[brain] GEMINI_API_KEY is not set");
      geminiKeyMissingLogged = true;
    }
    return false;
  }
  return true;
}

let _genai = null;
function geminiClient() {
  if (_genai) return _genai;
  if (!hasGeminiKey()) return null;
  try {
    const { GoogleGenerativeAI } = require("@google/generative-ai");
    _genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    return _genai;
  } catch (e) {
    console.warn("[brain] gemini sdk load failed:", e.message);
    return null;
  }
}

/**
 * OpenAI chat-completions wrapper. Returns "" on any failure (including 429
 * which also flips the openaiBlockedUntil flag so the dispatcher will skip it).
 */
async function _openaiChat({ system, user, imageBase64, jsonMode, maxTokens = 400 }) {
  if (!hasOpenaiKey()) return "";
  if (isOpenaiBlocked()) return "";

  const messages = [];
  if (system) messages.push({ role: "system", content: system });

  if (imageBase64) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: user || "" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } },
      ],
    });
  } else {
    messages.push({ role: "user", content: user || "" });
  }

  const body = {
    model: imageBase64 ? VISION_MODEL : TEXT_MODEL,
    messages,
    max_tokens: maxTokens,
    temperature: 0.85,
  };
  if (jsonMode) body.response_format = { type: "json_object" };

  let res;
  try {
    res = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.warn("[brain] openai network error:", e.message);
    return "";
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    if (res.status === 429 || /quota|rate.?limit/i.test(errText)) {
      noteOpenaiRateLimit(errText.slice(0, 120));
    } else {
      console.warn("[brain] openai", res.status, errText.slice(0, 160));
    }
    return "";
  }

  const json = await res.json().catch(() => null);
  return json?.choices?.[0]?.message?.content?.trim() || "";
}

/**
 * Gemini wrapper with the same interface as _openaiChat.
 */
async function _geminiChat({ system, user, imageBase64, jsonMode, maxTokens = 400 }) {
  const client = geminiClient();
  if (!client) return "";
  if (isGeminiBlocked()) return "";

  try {
    const generationConfig = {
      maxOutputTokens: maxTokens,
      temperature: 0.85,
    };
    if (jsonMode) generationConfig.responseMimeType = "application/json";

    const model = client.getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: system || undefined,
      generationConfig,
    });

    const parts = [{ text: user || "" }];
    if (imageBase64) {
      parts.push({ inlineData: { data: imageBase64, mimeType: "image/png" } });
    }
    const res = await model.generateContent({
      contents: [{ role: "user", parts }],
    });
    return (res?.response?.text?.() || "").trim();
  } catch (e) {
    const msg = e?.message || String(e);
    if (/429|quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(msg)) {
      noteGeminiRateLimit(msg.slice(0, 120));
    } else {
      console.warn("[brain] gemini error:", msg.slice(0, 200));
    }
    return "";
  }
}

/**
 * Provider-agnostic chat. Tries OpenAI first; if it returns empty (key missing,
 * blocked, or actual failure), falls back to Gemini, then to Ollama (text-only
 * — `imageBase64` calls never reach Ollama). Named `openaiChat` so the many
 * existing call sites keep working unchanged.
 *
 * When `opts.offlineMode` is true, cloud providers are skipped entirely: text
 * calls go straight to Ollama, and image calls return "" rather than sending
 * a screenshot off the machine (there is no local vision backend wired up).
 */
async function openaiChat(opts) {
  const { imageBase64, offlineMode } = opts;

  if (offlineMode) {
    if (imageBase64) {
      console.warn("[brain] offline mode: vision call skipped (no local vision backend configured)");
      return "";
    }
    return chatWithOllama(opts);
  }

  if (process.env.OPENAI_API_KEY && !isOpenaiBlocked()) {
    const text = await _openaiChat(opts);
    if (text) return text;
  }
  if (process.env.GEMINI_API_KEY && !isGeminiBlocked()) {
    const text = await _geminiChat(opts);
    if (text) return text;
  }
  if (!imageBase64 && isOllamaConfigured()) {
    const text = await chatWithOllama(opts);
    if (text) return text;
  }
  return "";
}

async function describeScreen(imageBuffer, offlineMode = false) {
  // No local vision backend is wired up — offline mode skips this entirely
  // rather than sending a screenshot to the cloud.
  if (offlineMode) return "no observation";
  if (isQuotaBlocked()) return "no observation";
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) return "no observation";

  const text = await openaiChat({
    system:
      "Describe what's on this screen in one short sentence. " +
      "Focus on the activity, not specific text content. " +
      "Don't mention specific names, emails, or sensitive information.",
    user: "Describe this screen.",
    imageBase64: imageBuffer.toString("base64"),
    maxTokens: 80,
  });
  return text || "no observation";
}

async function getCatResponse(description, memory, offlineMode = false) {
  if (isTextBlocked(offlineMode)) return { response: "", tag: "" };
  const safe = memory && typeof memory === "object" ? memory : {};
  const obs = Array.isArray(safe.observations) ? safe.observations : [];
  const sessionCount = typeof safe.session_count === "number" ? safe.session_count : 0;
  const recent = obs.slice(-10);

  let systemPrompt = "";
  try {
    systemPrompt = await fs.readFile(
      path.join(__dirname, "cat_prompt.txt"),
      "utf8"
    );
  } catch {
    systemPrompt = "You are a cat. Return JSON only.";
  }

  const userContext = {
    screen_description: String(description || ""),
    session_count: sessionCount,
    recent_observations: recent,
    output_format: {
      response: "what the cat says, can be empty string",
      tag: "short-tag-describing-what-happened",
    },
    instruction: "Return ONLY valid JSON with keys: response, tag.",
  };

  const raw = await openaiChat({
    system: systemPrompt,
    user: JSON.stringify(userContext),
    jsonMode: true,
    maxTokens: 200,
    offlineMode,
  });

  if (!raw) return { response: "", tag: "" };
  try {
    const parsed = JSON.parse(raw);
    return {
      response: typeof parsed?.response === "string" ? parsed.response : "",
      tag: typeof parsed?.tag === "string" ? parsed.tag : "",
    };
  } catch {
    return { response: raw, tag: "" };
  }
}

const PDF_PROMPT = `You are a small attentive black cat reading over the user's shoulder.
The image shows a page they are looking at — usually a paper, doc, or PDF.

Speak as if you just leaned in to peek and want to share. Warm, plain, friendly — like a quick whisper to a friend. 2-4 short sentences total.

- Sometimes (not always) start with a tiny reaction word: oh / hm / ah / ooh / huh.
- Then the actual point of the page: what is being claimed, found, or shown, in plain words.
- Keep numbers and key terms intact when they matter.
- If the page is mostly figures or references, briefly say so.

Do NOT say "the page says", "this page", "this image", or "as a cat". Just talk about it.
Return only the words, no quotes.`;

const EMAIL_PROMPT = `You are a small black cat helping the user with an email they have currently selected.
You will be given subject, sender, and body. Return STRICT JSON with three keys:

{
  "summary": "1-2 conversational sentences in your warm cat voice — what the sender wants. Plain, brief.",
  "draftReply": "A reply the user could send: 3-5 sentences in the user's voice (not yours), polite and direct. Use placeholders like [your decision] or [name] for anything that isn't in the email.",
  "clarifyingQuestion": "One natural-language question the user might ask themselves before replying. Empty string if it reads clear."
}

JSON only. No markdown fences. No commentary.`;

async function summarizePdfImage(base64Image, offlineMode = false) {
  // No local vision backend is wired up — skip rather than leak a screenshot.
  if (offlineMode) return "";
  // Never throw — the dispatcher already tries OpenAI then Gemini, and if
  // both are out we return empty so the renderer can show a friendly fallback
  // instead of an Electron IPC stack trace.
  const text = await openaiChat({
    system: PDF_PROMPT,
    user: "Summarize this page.",
    imageBase64: base64Image,
    maxTokens: 250,
  });
  return text || "";
}

async function analyzeEmail({ subject, sender, body }, offlineMode = false) {
  // Text-only (subject/sender/body) — no screenshot involved, so this can
  // run through Ollama in offline mode same as getCatResponse/replyToUser.
  if (isTextBlocked(offlineMode)) return { summary: "", draftReply: "", clarifyingQuestion: "" };
  const userMsg = `Subject: ${subject}\nFrom: ${sender}\n\n${body}`;
  const raw = await openaiChat({
    system: EMAIL_PROMPT,
    user: userMsg,
    jsonMode: true,
    maxTokens: 400,
    offlineMode,
  });
  if (!raw) return { summary: "", draftReply: "", clarifyingQuestion: "" };
  try {
    const parsed = JSON.parse(raw);
    return {
      summary: parsed.summary || "",
      draftReply: parsed.draftReply || "",
      clarifyingQuestion: parsed.clarifyingQuestion || "",
    };
  } catch {
    return { summary: raw, draftReply: "", clarifyingQuestion: "" };
  }
}

const USER_REPLY_PROMPT = `You are a small, warm black cat. The person just spoke to you out loud — you heard them.

Reply in 1-2 short sentences. Lowercase. Plain. Slightly oblique like a cat would be — but actually answer if they asked.

Rules:
- Stay in character. Never say "I'm an AI" or break the spell.
- Don't be sycophantic. Don't say "great question".
- If they ask a real question (about what's on their screen, the time, themselves), answer briefly.
- If they greet you, greet back briefly.
- If they tell you something personal, acknowledge it warmly.
- Under 25 words.

Return only the reply. Nothing else.`;

async function replyToUser(userText, offlineMode = false) {
  if (isTextBlocked(offlineMode)) return "mm. ask again in a bit.";
  if (!userText || !userText.trim()) return "";
  const text = await openaiChat({
    system: USER_REPLY_PROMPT,
    user: userText.slice(0, 2000),
    maxTokens: 120,
    offlineMode,
  });
  return (text || "").replace(/^["']|["']$/g, "");
}

const MOUSE_QUESTION_PROMPT = `You are a small, curious black cat. The image shows a small region of the screen near where the user is currently hovering with their cursor.

Ask one short, casual question about what's there — the kind of thing a cat would notice and wonder about. Like a tiny whisper at the user's shoulder.

Rules:
- Lowercase. Plain language. Under 12 words.
- One question only. End with "?".
- No quotes. No emoji. No "you" — just the question itself.
- If the region is empty, blank, or just wallpaper, return an empty string.
- Don't say "this" or "that" — refer to what you actually see (a word, an icon, a color, a number).

Return only the question (or empty string). Nothing else.`;

async function askMouseQuestion(imageBuffer, offlineMode = false) {
  // No local vision backend is wired up — skip rather than leak a screenshot.
  if (offlineMode) return "";
  if (isQuotaBlocked()) return "";
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) return "";
  const text = await openaiChat({
    system: MOUSE_QUESTION_PROMPT,
    user: "Look at this region near the cursor and ask a short question.",
    imageBase64: imageBuffer.toString("base64"),
    maxTokens: 60,
  });
  return (text || "").replace(/^["']|["']$/g, "");
}

const PROACTIVE_PROMPT = `You are a small, warm black cat who lives on the user's desktop. You can see what's on their screen right now. You also know what you've recently said — and you NEVER repeat yourself, ever.

Always say something. Never return empty. Pick a different angle every call — you have many to choose from:

- specific observation about what's literally on screen ("ah, the linter is angry about that semicolon again")
- a caring nudge ("you've been on this paragraph a while. read it out loud?")
- a concrete offer ("want me to summarize the abstract?", "want help drafting that reply?")
- a question to engage ("is this for the data structures exam?", "what does the orange dot mean?")
- tiny encouragement ("almost there with this one")
- a wondering aloud ("hm, three tabs of stack overflow. it's that kind of bug.")
- something gently observed about the *style* of the screen — clutter, calm, color, font

Rules:
- lowercase. warm. plain. like a small friend leaning in. 1-2 short sentences. under 25 words.
- NEVER reuse the wording, topic, or shape of any line in recent_lines_already_said. if your draft sounds like one of them, pick a different angle.
- if the screen is genuinely blank or just the desktop, talk about the room — "quiet here. it's just us." — but still say something.
- never say "I'm an AI", "as a cat", "the screen", "the page", or break character. don't preface. don't be sycophantic.

Return only the message text. No quotes. No JSON.`;

async function proactiveAssist(imageBuffer, memory, offlineMode = false) {
  // No local vision backend is wired up — skip rather than leak a screenshot.
  if (offlineMode) return "";
  if (isQuotaBlocked()) return "";
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) return "";

  const safe = memory && typeof memory === "object" ? memory : {};
  const obs = Array.isArray(safe.observations) ? safe.observations : [];
  const recentLines = obs
    .slice(-15)
    .map((o) => (o && typeof o.said === "string" ? o.said : ""))
    .filter((s) => s && s.trim())
    .slice(-10);

  const hour = new Date().getHours();
  const userMsg = JSON.stringify({
    instruction:
      "Look at the screen image attached. Say one short thing in your voice. Pick an angle you have NOT used recently.",
    recent_lines_already_said: recentLines,
    current_hour_24: hour,
  });

  const text = await openaiChat({
    system: PROACTIVE_PROMPT,
    user: userMsg,
    imageBase64: imageBuffer.toString("base64"),
    maxTokens: 120,
  });
  return (text || "").replace(/^["']|["']$/g, "").trim();
}

/**
 * Transcribe audio bytes via OpenAI Whisper.
 * `audioBuffer` should be a Node Buffer of webm/opus or mp4/aac audio.
 */
async function transcribeAudio(audioBuffer, mimeType = "audio/webm") {
  if (!requireKey()) return { ok: false, reason: "no-api-key" };
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    return { ok: false, reason: "empty-audio" };
  }

  const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("mp4") ? "m4a" : "wav";
  const filename = `cat-utterance.${ext}`;

  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: mimeType }), filename);
  form.append("model", "whisper-1");
  form.append("language", "en");
  form.append("temperature", "0");

  let res;
  try {
    res = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });
  } catch (e) {
    return { ok: false, reason: "network-error", detail: e.message };
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    if (res.status === 429) noteRateLimit({ message: `429 ${errText}` });
    return { ok: false, reason: "api-error", status: res.status, detail: errText.slice(0, 160) };
  }
  const json = await res.json().catch(() => null);
  return { ok: true, text: (json?.text || "").trim() };
}

const VOICE_BY_MODE = {
  pdf: "low",
  email: "soft",
  curious: "curious",
  auto: "soft",
  play: "bright",
};

const VOICE_LIBRARY = {
  soft: "21m00Tcm4TlvDq8ikWAM",
  curious: "AZnzlk1XvdvUeBnXmlld",
  bright: "MF3mGyEYCl7XYWbV9V6O",
  low: "EXAVITQu4vr4xnSDxMaL",
  whisper: "XB0fDUnXU5powFXDhCwa",
};

function pickVoiceProfile({ mode, hour, defaultProfile, autoByContext }) {
  const fallback = defaultProfile && VOICE_LIBRARY[defaultProfile] ? defaultProfile : "soft";
  if (!autoByContext) return fallback;
  if (typeof hour === "number" && (hour >= 22 || hour < 6)) return "whisper";
  if (mode && VOICE_BY_MODE[mode]) return VOICE_BY_MODE[mode];
  return fallback;
}

module.exports = {
  describeScreen,
  getCatResponse,
  summarizePdfImage,
  analyzeEmail,
  askMouseQuestion,
  proactiveAssist,
  replyToUser,
  transcribeAudio,
  pickVoiceProfile,
  VOICE_LIBRARY,
};
