# The Cat

A small, round, black cat that lives on your desktop. She watches quietly, occasionally says something brief, and remembers what she's seen across sessions.

She is **not** a productivity assistant. She's a presence — silent by default, oblique when she does speak, and increasingly familiar over time.

When she notices you reading a PDF or replying to an email, she shifts into an active "context copilot" mode and offers a short summary or a draft reply.

---

## Features

- **Transparent, frameless, always-on-top window** that floats over your desktop and can be dragged anywhere on the screen.
- **Seven-sprite state machine** — puddle (resting), awake, sleep, walk1/walk2 (walking cycle), annoyed, ball-play — with idle breathing, perk, tilt, and shake animations.
- **Two parallel cognition loops:**
  - *Autonomous loop* (~30 s): screenshots the screen, asks a vision model for a one-line description, then asks the cat-personality model whether to say anything. Most of the time, she stays silent.
  - *Active loop* (~4 s): polls the foreground macOS app + window. If you're reading a PDF or have a Mail message selected, the glass panel opens with a context-aware summary, draft reply, or clarifying question.
- **Provider-agnostic brain**: OpenAI (`gpt-4o-mini`) is tried first, with an automatic fallback to Gemini (`gemini-2.5-flash`) if OpenAI is rate-limited, unavailable, or its key is missing — each provider gets its own 429 backoff so the cat keeps talking.
- **Local/offline mode via Ollama**: a third fallback for text calls (cat replies, conversation, email analysis), and — when the "offline mode" setting is on — the *only* backend used, so nothing leaves the machine. Screen-watching, PDF summaries, and email mode pause in offline mode since there's no local vision model wired up.
- **Calendar integration**: Google Calendar (OAuth2) and Microsoft Outlook (Azure AD device-code flow) — reads upcoming events into the cat's screen context and can create new events. Talk to the cat ("what's on my calendar today?", "schedule lunch tomorrow at noon") and a regex-based intent parser routes the request to read or write a connected calendar.
- **Voice input**: hold the mic button, speak, and the recording is transcribed via OpenAI Whisper, parsed for calendar intent, and answered in character.
- **Voice output**: Qwen3 TTS (Alibaba DashScope) is the primary voice engine, with ElevenLabs as a secondary option and the platform's system TTS (`afplay` / Windows `System.Speech`) as the last-resort fallback. Five ElevenLabs voice profiles (soft, curious, bright, low, whisper) and a "match voice to work type" toggle pick profiles based on context (PDF, email, late-night).
- **Persistent memory** in `memory.json` — a rolling window of up to 100 observations carries across sessions.
- **Settings panel** to toggle voice, pick a profile, enable/disable context-aware voice switching, and enable offline mode. Settings persist in `settings.json`.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Electron app (main.js)                                              │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ IPC handlers:                                                │    │
│  │   capture-screen        → screencapture(1) → PNG buffer      │    │
│  │   cat:getContext        → osascript → frontmost app + Mail   │    │
│  │   cat:capturePrimary    → screencapture(1) → base64          │    │
│  │   cat:summarizePdf      → brain.summarizePdfImage            │    │
│  │   cat:analyzeEmail      → brain.analyzeEmail                 │    │
│  │   cat:replyToUser       → brain.replyToUser                  │    │
│  │   cat:transcribe        → brain.transcribeAudio (Whisper)    │    │
│  │   cat:proactiveAssist   → brain.proactiveAssist              │    │
│  │   cat:speak / voice:speak → Qwen3 → ElevenLabs → system TTS  │    │
│  │   cat:hasVoiceKey / cat:hasOllama                            │    │
│  │   cat:get/setSettings, read/write-memory                     │    │
│  │   calendar:readUpcoming / writeEvent / getConnected          │    │
│  │   calendar:connectGoogle / handleGoogleCode / connectOutlook │    │
│  │   listener:start / listener:stop → transcribe + calendar     │    │
│  │                                     intent → spoken reply    │    │
│  └──────────────────────────────────────────────────────────────┘    │
│           ▲                                              ▲           │
│           │ contextBridge (preload.js)                   │           │
│           ▼                                              │           │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ Renderer (renderer.js + index.html + styles.css)             │    │
│  │   • sprite manager + animation scheduler                     │    │
│  │   • autonomousTick (~30 s) / activeTick (~4 s)                │    │
│  │   • glass panel (Summary/Reply/Ask) + speech bubble           │    │
│  │   • mic button → MediaRecorder → listener:stop                │    │
│  │   • settings overlay (voice, offline mode)                    │    │
│  └──────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
                          │
                          ▼
        ┌────────────────────────────────────────┐
        │ brain.js — OpenAI → Gemini → Ollama     │
        │   describeScreen        (vision)        │
        │   getCatResponse        (text)          │
        │   summarizePdfImage     (vision)         │
        │   analyzeEmail          (text)           │
        │   replyToUser           (text)           │
        │   askMouseQuestion      (vision)          │
        │   proactiveAssist       (vision)          │
        │   transcribeAudio       (Whisper)         │
        │   pickVoiceProfile      (heuristic)       │
        ├────────────────────────────────────────┤
        │ ollama.js   — local LLM (text-only)     │
        │ voice.js    — Qwen3 TTS + system fallback│
        │ calendar.js — Google + Outlook providers │
        │               + voice-command intent     │
        │               parser                     │
        └────────────────────────────────────────┘
```

Cost discipline: a cheap vision call describes the screen, the personality model returns an empty string most of the time, capture-skipping by context fingerprint avoids redundant calls when nothing has changed, and per-provider rate-limit backoff routes around a blocked provider instead of hammering it.

---

## Setup

### Prerequisites

- **macOS** for the active context-copilot mode (AppleScript + `screencapture` — frontmost-app detection, Mail reading, and screenshotting are macOS-only). Voice output falls back to Windows `System.Speech` if you're experimenting on Windows, but screen-watching won't work there.
- **Node.js 18+** and npm.
- An **OpenAI API key** (primary text + vision + Whisper transcription) and/or a **Gemini API key** (fallback vision + text, free tier is fine — [get one here](https://aistudio.google.com/apikey)). At least one is needed for cloud mode.
- *(Optional)* an **ElevenLabs API key** for a secondary voice engine.
- *(Optional)* a **DashScope API key** for Qwen3 TTS (the primary voice engine).
- *(Optional)* **Google Cloud** OAuth2 credentials and/or an **Azure App Registration** for calendar integration.
- *(Optional)* **[Ollama](https://ollama.com)**, running locally, for a local/offline text backend — no API key needed, just `ollama pull llama3.1:8b` (or your model of choice) and `ollama serve`.

### Install

```bash
npm install
cp .env.example .env
# edit .env: add OPENAI_API_KEY and/or GEMINI_API_KEY at minimum,
# then whichever optional keys you want (ElevenLabs, DashScope, Google/Outlook, Ollama)
npm start
```

### macOS permissions (first run)

The first time you launch, macOS will prompt for two permissions. Both are required for the active mode to work:

1. **Screen Recording** — System Settings → Privacy & Security → Screen Recording → enable for your terminal (or for Electron itself once it appears in the list). Required for `screencapture`.
2. **Automation** — accept the prompts that ask permission to control "System Events" and "Mail". Required for detecting the foreground app and reading the selected email.

If you grant Screen Recording mid-session, **fully quit and relaunch** the terminal; macOS only re-reads TCC permissions on process startup.

---

## Configuration

### Environment variables (`.env`)

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | one of OpenAI/Gemini | Primary text + vision (`gpt-4o-mini` by default) and Whisper transcription for the mic feature. |
| `OPENAI_TEXT_MODEL` | no | Override the text model. Defaults to `gpt-4o-mini`. |
| `OPENAI_VISION_MODEL` | no | Override the vision model. Defaults to `gpt-4o-mini`. |
| `GEMINI_API_KEY` | one of OpenAI/Gemini | Fallback vision + text via `gemini-2.5-flash`, used automatically if OpenAI is rate-limited, errors, or its key is absent. |
| `GEMINI_MODEL` | no | Override the Gemini model. Defaults to `gemini-2.5-flash`. |
| `ELEVENLABS_API_KEY` | no | Secondary TTS engine (5 profiles). If absent, falls back further to system TTS. |
| `DASHSCOPE_API_KEY` | no | Alibaba DashScope key for Qwen3 TTS — the primary voice engine when set. Falls back to system TTS if absent or the call fails. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | no | Google OAuth2 desktop-app credentials for Google Calendar read/write. [Create at Google Cloud Console](https://console.cloud.google.com). |
| `GOOGLE_REDIRECT_URI` | no | Defaults to the OOB redirect (`urn:ietf:wg:oauth:2.0:oob`). |
| `OUTLOOK_CLIENT_ID` | no | Azure App Registration client ID for Outlook Calendar (device-code flow). [Create at Azure Portal](https://portal.azure.com). |
| `OUTLOOK_TENANT_ID` | no | Defaults to `common`. |
| `OLLAMA_ENABLED` | no | Set `true` to enable the local Ollama backend (text-only: cat replies, conversation, email analysis). Third fallback after OpenAI/Gemini, and the sole backend when offline mode is on. |
| `OLLAMA_BASE_URL` | no | Ollama server URL. Defaults to `http://localhost:11434`. |
| `OLLAMA_MODEL` | no | Local model tag to use. Defaults to `llama3.1:8b` — pull it first with `ollama pull llama3.1:8b` (or point this at any model you already have installed; check with `ollama list`). |

### Settings (`settings.json`, written by the app)

| Field | Default | Purpose |
| --- | --- | --- |
| `voiceEnabled` | `true` | Master voice toggle. |
| `voiceProfile` | `"soft"` | Default ElevenLabs profile (`soft` / `curious` / `bright` / `low` / `whisper`). |
| `autoVoiceByContext` | `true` | When on, profile is picked from work type + time of day (e.g. `whisper` after 22:00, `low` for PDFs, `soft` for email). |
| `mouseQuestionsEnabled` | `true` | Whether the cat asks short questions about whatever's under the cursor (dwell + active-motion triggers). |
| `offlineMode` | `false` | When on, all conversation/reply calls route through Ollama only (no OpenAI/Gemini). Screen-watching, PDF summaries, and email mode pause in this mode — there is no local vision model wired up, so those calls are skipped rather than silently sent to the cloud. Requires `OLLAMA_ENABLED=true`. |

Open the in-app settings panel via the gear icon on the cat.

---

## Project structure

```
.
├── main.js              # Electron main process, IPC handlers, AppleScript bridges
├── preload.js           # contextBridge: exposes `window.desktopCat` to renderer
├── renderer.js          # sprite state machine, both ticks, panel + voice UI
├── brain.js             # OpenAI/Gemini/Ollama dispatch + voice profile selection
├── ollama.js            # local LLM backend (Ollama REST API), text-only
├── voice.js             # Qwen3 TTS (DashScope) + system-TTS fallback
├── calendar.js          # Google/Outlook calendar providers + voice-command intent parser
├── listener.js          # mic IPC: audio → Whisper transcript → calendar intent → reply
├── cat_prompt.txt       # personality prompt (system instruction)
├── index.html           # cat sprites + glass panel + settings overlay
├── styles.css           # all visual states + keyframe animations
├── assets/              # cat sprites used at runtime (PNG)
├── cat_images/          # source sprites in PNG + SVG (asset library)
└── docs/
    └── execution.md     # hackathon execution plan & team coordination
```

Files written at runtime (gitignored): `.env`, `memory.json`, `settings.json`, `journal.txt`, `calendar_tokens.json`.

---

## Troubleshooting

**`Error occurred in handler for 'capture-screen': Failed to get sources.`**
The terminal (or Electron) doesn't have Screen Recording permission. Open System Settings → Privacy & Security → Screen Recording, enable the entry for your terminal app, then quit and relaunch. The capture path now uses `screencapture(1)`, so as long as the CLI permission is granted, it will work.

**The active panel never opens for PDFs or email.**
Confirm the foreground app is one of: Preview, Adobe Acrobat, a browser viewing a `.pdf` URL, or Mail.app with a message *actually selected*. Open Console.app and look for `[cat] mode=...` log lines from `npm start` — they tell you what mode the classifier picked.

**The cat says nothing for long stretches.**
That's intended. The personality prompt instructs her to return an empty string most of the time. Click the cat to force a tick.

**Voice is silent even though `voiceEnabled` is true.**
Check the settings panel — if the warning reads "no ELEVENLABS_API_KEY in .env", add the key to `.env` and restart. Note Qwen3 (`DASHSCOPE_API_KEY`) is tried first if set; ElevenLabs is the secondary engine.

**Offline mode toggle shows "Ollama not configured".**
Set `OLLAMA_ENABLED=true` in `.env`, make sure `ollama serve` is running, and that `OLLAMA_MODEL` (default `llama3.1:8b`) is actually pulled — check with `ollama list` and `ollama pull <model>` if it's missing. Restart the app after editing `.env`.

**Google/Outlook calendar won't connect.**
Google needs `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` from a Google Cloud OAuth2 *Desktop app* credential; Outlook needs an Azure App Registration `OUTLOOK_CLIENT_ID` with `Calendars.ReadWrite` + `offline_access` permissions. Tokens persist in `calendar_tokens.json` — delete it to force re-authorization.

---

## Documentation

- [`docs/execution.md`](docs/execution.md) — hackathon execution plan, team coordination, and the original 3-hour scope decisions.

---

## License

MIT.
