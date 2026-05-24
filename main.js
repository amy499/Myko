require("dotenv").config();

const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
} = require("electron");
const path = require("path");
const fs = require("fs/promises");
const fsSync = require("fs");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");

const brain = require("./brain");
const { CalendarManager, GoogleCalendarProvider, OutlookCalendarProvider } = require("./calendar");
const { speakWithQwen3, isQwen3Available } = require("./voice");
const listenerModule = require("./listener");

const execFileP = promisify(execFile);

const MEMORY_PATH = path.join(__dirname, "memory.json");
const SETTINGS_PATH = path.join(__dirname, "settings.json");

const DEFAULT_SETTINGS = {
  voiceEnabled: true,
  voiceProfile: "soft",
  autoVoiceByContext: true,
  mouseQuestionsEnabled: true,
};

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 380,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const { width } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow.setPosition(Math.max(width - 500, 0), 120);
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.loadFile("index.html");
}

/* ---------- calendar provider instances (may be null if keys absent) ---------- */
let calendar = null;
let googleProvider = null;
let outlookProvider = null;

app.whenReady().then(async () => {
  createWindow();
  startMouseDwellWatcher();

  // Initialize CalendarManager and register whichever providers have keys.
  calendar = new CalendarManager();

  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    googleProvider = new GoogleCalendarProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      redirectUri: process.env.GOOGLE_REDIRECT_URI || "urn:ietf:wg:oauth:2.0:oob",
    });
    calendar.register(googleProvider);
    console.log("[calendar] Google Calendar provider registered");
  } else {
    console.log("[calendar] GOOGLE_CLIENT_ID/SECRET not set — Google Calendar skipped");
  }

  if (process.env.OUTLOOK_CLIENT_ID) {
    outlookProvider = new OutlookCalendarProvider({
      clientId: process.env.OUTLOOK_CLIENT_ID,
      tenantId: process.env.OUTLOOK_TENANT_ID || "common",
    });
    calendar.register(outlookProvider);
    console.log("[calendar] Outlook Calendar provider registered");
  } else {
    console.log("[calendar] OUTLOOK_CLIENT_ID not set — Outlook Calendar skipped");
  }

  // Give listener.js access to the calendar instance for intent handling.
  listenerModule.setCalendar(calendar);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/* ---------- mouse question loop (dwell + active movement) ---------- */
const MOUSE_POLL_MS = 500;
const DWELL_TRIGGER_MS = 1200;
const QUESTION_COOLDOWN_MS = 10000;
const MIN_MOVE_FROM_LAST_Q = 80;
const ACTIVE_WINDOW_MS = 8000;
const ACTIVE_DISTANCE_PX = 1500;
const ACTIVE_COOLDOWN_MS = 14000;
const REGION_W = 480;
const REGION_H = 320;

let mouseLast = null;
let dwellStartedAt = 0;
let lastQuestionAt = 0;
let lastQuestionAt_pos = null;
let mouseQuestionInFlight = false;
let mouseTrack = []; // {t, x, y} samples for active-movement detector
let lastActiveQuestionAt = 0;

function dist(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function totalDistance(track) {
  let d = 0;
  for (let i = 1; i < track.length; i++) d += dist(track[i], track[i - 1]);
  return d;
}

function startMouseDwellWatcher() {
  setInterval(async () => {
    if (!mainWindow || mouseQuestionInFlight) return;

    const settings = await readSettings();
    if (!settings.mouseQuestionsEnabled) return;

    const now = Date.now();
    const cursor = screen.getCursorScreenPoint();

    // Maintain rolling window of cursor positions for active-movement detection.
    mouseTrack.push({ t: now, x: cursor.x, y: cursor.y });
    mouseTrack = mouseTrack.filter((p) => now - p.t < ACTIVE_WINDOW_MS);

    if (!mouseLast) {
      mouseLast = cursor;
      dwellStartedAt = now;
      return;
    }

    const moving = dist(cursor, mouseLast) > 4;
    if (moving) {
      mouseLast = cursor;
      dwellStartedAt = now;
    }

    const dwell = now - dwellStartedAt;
    const sinceQ = now - lastQuestionAt;
    const movedFromLastQ = lastQuestionAt_pos
      ? dist(cursor, lastQuestionAt_pos)
      : Infinity;

    // Branch A: cursor sat still long enough — ask about what's under it.
    const dwellTrigger =
      !moving &&
      dwell > DWELL_TRIGGER_MS &&
      sinceQ > QUESTION_COOLDOWN_MS &&
      movedFromLastQ > MIN_MOVE_FROM_LAST_Q;

    // Branch B: cursor has been busy — talk during active browsing too.
    const activeMove = totalDistance(mouseTrack);
    const activeTrigger =
      moving &&
      activeMove > ACTIVE_DISTANCE_PX &&
      now - lastActiveQuestionAt > ACTIVE_COOLDOWN_MS &&
      sinceQ > QUESTION_COOLDOWN_MS;

    if (dwellTrigger || activeTrigger) {
      lastQuestionAt = now;
      lastQuestionAt_pos = { x: cursor.x, y: cursor.y };
      if (activeTrigger) lastActiveQuestionAt = now;
      mouseQuestionInFlight = true;
      askMouseQuestion(cursor)
        .catch((e) => console.warn("[cat] mouse question failed:", e.message))
        .finally(() => {
          mouseQuestionInFlight = false;
        });
    }
  }, MOUSE_POLL_MS);
}

async function askMouseQuestion(cursor) {
  const x = Math.max(0, Math.round(cursor.x - REGION_W / 2));
  const y = Math.max(0, Math.round(cursor.y - REGION_H / 2));
  const tmp = path.join(os.tmpdir(), `cat-region-${Date.now()}.png`);
  try {
    await execFileP("screencapture", [
      "-x",
      "-t",
      "png",
      "-R",
      `${x},${y},${REGION_W},${REGION_H}`,
      tmp,
    ]);
    const buf = await fs.readFile(tmp);
    const question = await brain.askMouseQuestion(buf);
    if (question && question.trim() && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("cat:mouseQuestion", question.trim());
    }
  } finally {
    fs.unlink(tmp).catch(() => {});
  }
}

ipcMain.on("drag-window", (_e, delta) => {
  if (!mainWindow || !delta) return;
  const [x, y] = mainWindow.getPosition();
  mainWindow.setPosition(Math.round(x + delta.x), Math.round(y + delta.y));
});

ipcMain.handle("capture-screen", async () => {
  // `desktopCapturer.getSources` is unreliable on macOS Sequoia without TCC
  // approval; the `screencapture` CLI works as long as Terminal/Electron has
  // Screen Recording permission — same path used by cat:capturePrimary.
  const tmp = path.join(os.tmpdir(), `cat-cap-${Date.now()}.png`);
  try {
    await execFileP("screencapture", ["-x", "-t", "png", tmp]);
    return await fs.readFile(tmp);
  } catch (e) {
    console.error("[cat] capture-screen failed:", e.message);
    return null;
  } finally {
    fs.unlink(tmp).catch(() => {});
  }
});

ipcMain.handle("describe-screen", async (_e, imageBuffer) => {
  const buf = Buffer.isBuffer(imageBuffer)
    ? imageBuffer
    : Buffer.from(imageBuffer);
  return brain.describeScreen(buf);
});

ipcMain.handle("get-cat-response", async (_e, description, memory) => {
  let enrichedDescription = description;
  if (calendar) {
    const calendarContext = await calendar.getContextSummary(24);
    if (calendarContext) {
      enrichedDescription = `${description}\n\nUpcoming events:\n${calendarContext}`;
    }
  }
  return brain.getCatResponse(enrichedDescription, memory);
});

ipcMain.handle("read-memory", async () => {
  try {
    const raw = await fs.readFile(MEMORY_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return { observations: [], session_count: 0 };
  }
});

ipcMain.handle("write-memory", async (_e, memory) => {
  await fs.writeFile(MEMORY_PATH, JSON.stringify(memory, null, 2), "utf8");
});

const FRONT_APP_SCRIPT = `
tell application "System Events"
  set frontApp to name of first application process whose frontmost is true
  set frontTitle to ""
  try
    tell process frontApp
      if (count of windows) > 0 then
        set frontTitle to name of front window
      end if
    end tell
  end try
  return frontApp & "|||SEP|||" & frontTitle
end tell
`;

const MAIL_SELECTION_SCRIPT = `
tell application "Mail"
  try
    set sel to selection
    if (count of sel) is 0 then return ""
    set msg to item 1 of sel
    set s to subject of msg
    set f to (sender of msg) as string
    set b to content of msg
    return s & "|||SEP|||" & f & "|||SEP|||" & b
  on error
    return ""
  end try
end tell
`;

async function osa(script) {
  try {
    const { stdout } = await execFileP("osascript", ["-e", script], {
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.toString().trim();
  } catch {
    return "";
  }
}

function classifyMode(appName, title) {
  const a = (appName || "").toLowerCase();
  const t = (title || "").toLowerCase();
  if (a === "mail") return "email";
  if (a === "preview") return "pdf";
  if (a.includes("acrobat")) return "pdf";
  const browsers = [
    "google chrome",
    "safari",
    "arc",
    "brave browser",
    "microsoft edge",
    "firefox",
  ];
  if (browsers.includes(a) && t.includes(".pdf")) return "pdf";
  return "idle";
}

let lastLoggedMode = null;
function logMode(mode, appName, title) {
  if (mode === lastLoggedMode) return;
  lastLoggedMode = mode;
  console.log(
    `[cat] mode=${mode} app=${appName || "?"} title=${(title || "").slice(0, 60)}`
  );
}

ipcMain.handle("cat:getContext", async () => {
  const front = await osa(FRONT_APP_SCRIPT);
  const [appName = "", title = ""] = front.split("|||SEP|||");
  const mode = classifyMode(appName, title);
  logMode(mode, appName, title);
  if (mode === "email") {
    const sel = await osa(MAIL_SELECTION_SCRIPT);
    if (!sel) return { mode: "idle", appName, title };
    const [subject = "", sender = "", body = ""] = sel.split("|||SEP|||");
    return {
      mode,
      appName,
      title,
      mail: { subject, sender, body: body.slice(0, 6000) },
    };
  }
  return { mode, appName, title };
});

ipcMain.handle("cat:capturePrimary", async () => {
  const tmp = path.join(os.tmpdir(), `cat-cap-${Date.now()}.png`);
  try {
    await execFileP("screencapture", ["-x", "-t", "png", tmp]);
    const buf = await fs.readFile(tmp);
    return buf.toString("base64");
  } finally {
    fs.unlink(tmp).catch(() => {});
  }
});

ipcMain.handle("cat:summarizePdf", async (_e, b64) => {
  try {
    return await brain.summarizePdfImage(b64);
  } catch (e) {
    console.error("[cat] summarizePdf failed:", e.message);
    throw e;
  }
});

ipcMain.handle("cat:analyzeEmail", async (_e, mail) => {
  try {
    return await brain.analyzeEmail(mail);
  } catch (e) {
    console.error("[cat] analyzeEmail failed:", e.message);
    throw e;
  }
});

ipcMain.handle("cat:speak", async (_e, { text, profile, mode }) => {
  if (!process.env.ELEVENLABS_API_KEY) {
    return { ok: false, reason: "no-api-key" };
  }
  if (!text || !text.trim()) return { ok: false, reason: "empty-text" };

  const settings = await readSettings();
  const chosenProfile = brain.pickVoiceProfile({
    mode,
    hour: new Date().getHours(),
    defaultProfile: profile || settings.voiceProfile,
    autoByContext: settings.autoVoiceByContext,
  });
  const voiceId = brain.VOICE_LIBRARY[chosenProfile] || brain.VOICE_LIBRARY.soft;

  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_flash_v2_5",
          voice_settings: { stability: 0.55, similarity_boost: 0.75 },
        }),
      }
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      let detail = "";
      try {
        const j = JSON.parse(errText);
        detail = j?.detail?.status || j?.detail?.message || j?.message || "";
      } catch {
        detail = errText.slice(0, 120);
      }
      console.error("[cat] elevenlabs failed:", res.status, detail);
      return { ok: false, reason: "api-error", status: res.status, detail };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, audio: buf.toString("base64"), profile: chosenProfile };
  } catch (e) {
    console.error("[cat] speak fetch failed:", e.message);
    return { ok: false, reason: "network-error" };
  }
});

async function readSettings() {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf8");
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

ipcMain.handle("cat:getSettings", async () => readSettings());

ipcMain.handle("cat:setSettings", async (_e, partial) => {
  const current = await readSettings();
  const next = { ...current, ...(partial || {}) };
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
});

ipcMain.handle("cat:hasVoiceKey", async () =>
  Boolean(process.env.ELEVENLABS_API_KEY)
);

ipcMain.handle("cat:replyToUser", async (_e, userText) => {
  try {
    return await brain.replyToUser(userText);
  } catch (e) {
    console.error("[cat] replyToUser failed:", e.message);
    return "";
  }
});

ipcMain.handle("cat:transcribe", async (_e, audio, mimeType) => {
  try {
    const buf = Buffer.isBuffer(audio) ? audio : Buffer.from(audio || []);
    return await brain.transcribeAudio(buf, mimeType || "audio/webm");
  } catch (e) {
    console.error("[cat] transcribe failed:", e.message);
    return { ok: false, reason: "exception", detail: e.message };
  }
});

ipcMain.handle("cat:hasTranscriptionKey", async () =>
  Boolean(process.env.OPENAI_API_KEY)
);

ipcMain.handle("cat:proactiveAssist", async () => {
  const tmp = path.join(os.tmpdir(), `cat-proactive-${Date.now()}.png`);
  try {
    await execFileP("screencapture", ["-x", "-t", "png", tmp]);
    const buf = await fs.readFile(tmp);
    let memory = { observations: [], session_count: 0 };
    try {
      memory = JSON.parse(await fs.readFile(MEMORY_PATH, "utf8"));
    } catch {}
    return await brain.proactiveAssist(buf, memory);
  } catch (e) {
    console.error("[cat] proactiveAssist failed:", e.message);
    return "";
  } finally {
    fs.unlink(tmp).catch(() => {});
  }
});

/* ---------- calendar IPC handlers ---------- */

ipcMain.handle("calendar:readUpcoming", async () => {
  if (!calendar) return [];
  return calendar.readAllUpcoming(7);
});

ipcMain.handle("calendar:writeEvent", async (_e, providerName, eventData) => {
  if (!calendar) return null;
  return calendar.writeEvent(providerName, eventData);
});

ipcMain.handle("calendar:getConnected", async () => {
  if (!calendar) return [];
  return calendar.getConnectedProviders().map((p) => p.name);
});

ipcMain.handle("calendar:connectGoogle", async () => {
  if (!googleProvider) return null;
  return googleProvider.getAuthUrl();
});

ipcMain.handle("calendar:handleGoogleCode", async (_e, code) => {
  if (!googleProvider) return null;
  return googleProvider.handleAuthCode(code);
});

ipcMain.handle("calendar:connectOutlook", async () => {
  if (!outlookProvider) return null;
  await outlookProvider.connect((message, code, url) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("calendar:outlookDeviceCode", { message, code, url });
    }
  });
});

/* ---------- voice:speak (Qwen3 with ElevenLabs fallback) ---------- */

ipcMain.handle("voice:speak", async (_e, text) => {
  if (!text || !text.trim()) return { ok: false, reason: "empty-text" };
  if (isQwen3Available()) {
    try {
      await speakWithQwen3(text);
      return { ok: true, engine: "qwen3" };
    } catch (e) {
      console.error("[voice] Qwen3 speak failed:", e.message);
    }
  }
  // Fall back to the existing ElevenLabs handler logic.
  if (!process.env.ELEVENLABS_API_KEY) {
    return { ok: false, reason: "no-api-key" };
  }
  const settings = await readSettings();
  const profile = settings.voiceProfile || "soft";
  const voiceId = brain.VOICE_LIBRARY[profile] || brain.VOICE_LIBRARY.soft;
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_flash_v2_5",
          voice_settings: { stability: 0.55, similarity_boost: 0.75 },
        }),
      }
    );
    if (!res.ok) return { ok: false, reason: "api-error", status: res.status };
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, audio: buf.toString("base64"), engine: "elevenlabs" };
  } catch (e) {
    console.error("[voice] ElevenLabs fallback failed:", e.message);
    return { ok: false, reason: "network-error" };
  }
});

/* ---------- settings file bootstrap ---------- */

if (!fsSync.existsSync(SETTINGS_PATH)) {
  fsSync.writeFileSync(
    SETTINGS_PATH,
    JSON.stringify(DEFAULT_SETTINGS, null, 2),
    "utf8"
  );
}
