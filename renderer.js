const cat = window.desktopCat;

/* ---------- DOM ---------- */
const $panel = document.getElementById("panel");
const $mode = document.getElementById("panel-mode");
const $title = document.getElementById("panel-title");
const $panelClose = document.getElementById("panel-close");
const $tabs = document.getElementById("panel-tabs");
const $tabButtons = $tabs.querySelectorAll(".tab");
const $spinner = document.getElementById("panel-spinner");
const $content = document.getElementById("panel-content");
const $actions = document.getElementById("panel-actions");
const $copy = document.getElementById("copy-btn");

const $bubble = document.getElementById("bubble");

const $catWrapper = document.getElementById("cat-wrapper");
const $catStack = document.getElementById("cat-stack");
const $settingsBtn = document.getElementById("settings-btn");
const $micBtn = document.getElementById("mic-btn");
const $micStatus = document.getElementById("mic-status");

const $settingsOverlay = document.getElementById("settings-overlay");
const $settingsClose = document.getElementById("settings-close");
const $voiceToggle = document.getElementById("voice-toggle");
const $voiceProfile = document.getElementById("voice-profile");
const $autoVoice = document.getElementById("auto-voice");
const $voiceStatus = document.getElementById("voice-status");
const $offlineToggle = document.getElementById("offline-toggle");
const $offlineStatus = document.getElementById("offline-status");

const SPRITES = {
  puddle: document.getElementById("s-puddle"),
  awake: document.getElementById("s-awake"),
  sleep: document.getElementById("s-sleep"),
  walk1: document.getElementById("s-walk1"),
  walk2: document.getElementById("s-walk2"),
  annoyed: document.getElementById("s-annoyed"),
  play: document.getElementById("s-play"),
};

/* ---------- timing constants ---------- */
const AUTONOMOUS_MS = 20000;
const ACTIVE_MS = 4000;
const SLEEP_AFTER_PUDDLE_MS = 90000;
const PUDDLE_AFTER_AWAKE_MS = 22000;
const ANNOYED_DURATION_MS = 2800;
const PLAY_DURATION_MS = 5500;
const WALK_FRAME_MS = 250;
const WALK_DURATION_MS = 4500;

/* ---------- state ---------- */
const state = {
  sprite: "puddle",
  mode: "idle",
  activeFp: "",
  activeBusy: false,
  emailResult: null,
  pdfResult: "",
  activeTab: "summary",
  panelDismissed: false,
  lastActiveAt: 0,
  speakingUntil: 0,
  walking: false,
  playing: false,
  annoyed: false,
  settings: {
    voiceEnabled: false,
    voiceProfile: "soft",
    autoVoiceByContext: true,
    offlineMode: false,
  },
  hasVoiceKey: false,
  hasOllama: false,
  currentAudio: null,
};

/* ---------- sprite manager ---------- */
function setSprite(name) {
  if (!SPRITES[name] || state.sprite === name) return;
  Object.keys(SPRITES).forEach((k) => SPRITES[k].classList.remove("active"));
  SPRITES[name].classList.add("active");
  state.sprite = name;
}

function pokeAwake() {
  state.lastActiveAt = Date.now();
  if (
    state.sprite !== "annoyed" &&
    state.sprite !== "walk1" &&
    state.sprite !== "walk2" &&
    state.sprite !== "play"
  ) {
    setSprite("awake");
  }
}

function playOnce(cls, dur = 1000) {
  $catStack.classList.remove(cls);
  void $catStack.offsetWidth;
  $catStack.classList.add(cls);
  setTimeout(() => $catStack.classList.remove(cls), dur);
}

function perk() {
  playOnce("perk", 700);
}

function shake() {
  $catWrapper.classList.remove("shake");
  void $catWrapper.offsetWidth;
  $catWrapper.classList.add("shake");
  setTimeout(() => $catWrapper.classList.remove("shake"), 400);
}

function tiltSometimes() {
  if (state.sprite !== "awake") return;
  if (Math.random() < 0.5) playOnce("tilt-left", 900);
  else playOnce("tilt-right", 900);
}

function flashAnnoyed() {
  if (state.walking || state.playing) return;
  state.annoyed = true;
  setSprite("annoyed");
  shake();
  setTimeout(() => {
    state.annoyed = false;
    setSprite("puddle");
  }, ANNOYED_DURATION_MS);
}

function startWalkCycle() {
  if (state.walking || state.playing || state.activeBusy || state.annoyed) return;
  state.walking = true;
  let frame = 0;
  setSprite("walk1");
  const id = setInterval(() => {
    frame++;
    setSprite(frame % 2 === 0 ? "walk1" : "walk2");
  }, WALK_FRAME_MS);
  setTimeout(() => {
    clearInterval(id);
    state.walking = false;
    setSprite("puddle");
  }, WALK_DURATION_MS);
}

function startPlay() {
  if (state.walking || state.playing || state.activeBusy || state.annoyed) return;
  state.playing = true;
  setSprite("play");
  $catStack.classList.add("bounce");
  setTimeout(() => {
    $catStack.classList.remove("bounce");
    state.playing = false;
    setSprite("puddle");
  }, PLAY_DURATION_MS);
}

function maybeSleep() {
  if (
    state.activeBusy ||
    state.walking ||
    state.playing ||
    state.annoyed ||
    Date.now() < state.speakingUntil
  ) {
    return;
  }
  const sinceActive = Date.now() - state.lastActiveAt;
  const hour = new Date().getHours();
  const isNight = hour >= 22 || hour < 6;

  if (
    state.sprite !== "sleep" &&
    sinceActive > SLEEP_AFTER_PUDDLE_MS &&
    isNight
  ) {
    setSprite("sleep");
    return;
  }
  if (
    (state.sprite === "awake" || state.sprite === "annoyed") &&
    sinceActive > PUDDLE_AFTER_AWAKE_MS
  ) {
    setSprite("puddle");
  }
}

/* ---------- speech (bubble + voice) ---------- */
function showBubble(text, durationMs = 7500) {
  if (!text || !text.trim()) return;
  $bubble.textContent = text;
  $bubble.classList.remove("hidden");
  requestAnimationFrame(() => $bubble.classList.add("visible"));
  clearTimeout(showBubble._timer);
  showBubble._timer = setTimeout(() => {
    $bubble.classList.remove("visible");
    setTimeout(() => $bubble.classList.add("hidden"), 280);
  }, durationMs);
}

function stopAudio() {
  if (state.currentAudio) {
    try {
      state.currentAudio.pause();
    } catch {}
    state.currentAudio = null;
  }
  $bubble.classList.remove("speaking");
  $catWrapper.classList.remove("talking");
  if ("speechSynthesis" in window) {
    try { window.speechSynthesis.cancel(); } catch {}
  }
}

function startTalkingVisuals() {
  $catWrapper.classList.add("talking");
}
function stopTalkingVisuals() {
  $catWrapper.classList.remove("talking");
  $bubble.classList.remove("speaking");
}

function applyProfileColor(profile) {
  if (!profile) return;
  $catWrapper.dataset.profile = profile;
}

/* ---------- recent-line memory (avoid repeats) ---------- */
const RECENT_LIMIT = 12;
const recentSpoken = [];

function normalizeLine(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function recentlySaid(text) {
  const n = normalizeLine(text);
  if (!n) return false;
  return recentSpoken.includes(n);
}

function rememberSaid(text) {
  const n = normalizeLine(text);
  if (!n) return;
  recentSpoken.push(n);
  if (recentSpoken.length > RECENT_LIMIT) recentSpoken.shift();
}

const FALLBACK_LINES = [
  "I'm just watching for a bit.",
  "still settling in.",
  "let's see what comes next.",
  "quiet here. it's just us.",
  "I'll wait for something to catch me.",
  "the room is calm. that's nice too.",
];

function pickFreshFallback() {
  const candidates = FALLBACK_LINES.filter((l) => !recentlySaid(l));
  if (candidates.length === 0) return null; // we've used them all recently — stay silent
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// Per-profile ambient animation. The CSS reads this class to swap which
// idle motion the cat does, so each voice has its own body language.
const PROFILE_ANIMS = ["soft", "curious", "bright", "low", "whisper"];
function applyProfileAnimation(profile) {
  if (!profile) return;
  PROFILE_ANIMS.forEach((p) => $catWrapper.classList.remove(`anim-${p}`));
  $catWrapper.classList.add(`anim-${profile}`);
}

// Per-mode sprite + animation cue. Fires when the cat starts speaking
// so each work type *looks* different, not just sounds different.
const MODE_SPRITE_CUE = {
  pdf:     { sprite: "awake", anim: "tilt-left",  animDur: 900 },
  email:   { sprite: "awake", anim: "tilt-right", animDur: 900 },
  curious: { sprite: "awake", anim: "perk",       animDur: 700 },
  auto:    { sprite: null,    anim: null,         animDur: 0   },
  play:    { sprite: "play",  anim: null,         animDur: 0   },
};

// Voice profile → resting sprite + tagline spoken when the user changes profile.
const VOICE_PROFILE_LOOK = {
  soft:    { sprite: "puddle", tagline: "softly here." },
  curious: { sprite: "awake",  tagline: "ears up. what's that?" },
  bright:  { sprite: "play",   tagline: "ready to play." },
  low:     { sprite: "puddle", tagline: "settled. low and slow." },
  whisper: { sprite: "sleep",  tagline: "shh. listening." },
};

function applyModeCue(mode) {
  const cue = MODE_SPRITE_CUE[mode];
  if (!cue) return;
  if (state.walking || state.annoyed) return;
  if (cue.sprite && state.sprite !== cue.sprite) {
    if (state.sprite !== "play") setSprite(cue.sprite);
  }
  if (cue.anim) playOnce(cue.anim, cue.animDur);
}

function speakWithBrowserTTS(text) {
  if (!("speechSynthesis" in window)) return false;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    u.pitch = 1.05;
    u.volume = 0.85;
    $bubble.classList.add("speaking");
    startTalkingVisuals();
    u.onstart = () => startTalkingVisuals();
    u.onend = () => stopTalkingVisuals();
    u.onerror = () => stopTalkingVisuals();
    window.speechSynthesis.speak(u);
    return true;
  } catch {
    return false;
  }
}

async function speakAndShow(text, { mode, allowRepeat } = {}) {
  if (!text || !text.trim()) return;
  if (!allowRepeat && recentlySaid(text)) {
    console.log("[cat] skipping repeat:", text.slice(0, 50));
    return;
  }
  rememberSaid(text);
  showBubble(text);
  pokeAwake();
  applyModeCue(mode);
  state.speakingUntil = Date.now() + Math.min(text.length * 70, 12000);

  if (!state.settings.voiceEnabled) return;

  if (state.hasVoiceKey) {
    try {
      const res = await cat.speak({
        text,
        mode,
        profile: state.settings.voiceProfile,
      });
      if (res && res.ok && res.audio) {
        stopAudio();
        const audio = new Audio(`data:audio/mpeg;base64,${res.audio}`);
        audio.volume = 0.75;
        state.currentAudio = audio;
        $bubble.classList.add("speaking");
        audio.onplay = () => startTalkingVisuals();
        audio.onended = () => {
          stopTalkingVisuals();
          if (state.currentAudio === audio) state.currentAudio = null;
        };
        audio.onerror = () => stopTalkingVisuals();
        await audio.play().catch(() => stopTalkingVisuals());
        if (res.profile) applyProfileColor(res.profile);
        return;
      }
      // ElevenLabs unavailable — fall through to browser TTS.
      if (res && !res.ok) {
        console.warn("[cat] elevenlabs unavailable, using browser TTS:", res.detail || res.reason || "");
      }
    } catch (e) {
      console.warn("[cat] voice failed, using browser TTS:", e?.message || e);
    }
  }

  speakWithBrowserTTS(text);
}

/* ---------- active panel (pdf / email) ---------- */
function showPanel() {
  state.panelDismissed = false;
  $panel.classList.remove("hidden");
  requestAnimationFrame(() => $panel.classList.add("visible"));
}

function hidePanel() {
  $panel.classList.remove("visible");
  setTimeout(() => $panel.classList.add("hidden"), 220);
}

function setSpinner(on) {
  $spinner.classList.toggle("hidden", !on);
  $content.classList.toggle("dim", on);
  $catWrapper.classList.toggle("thinking", on);
}

function setMode(mode, titleText) {
  state.mode = mode;
  $mode.dataset.mode = mode;
  $mode.textContent =
    mode === "pdf" ? "reading" : mode === "email" ? "letter" : "watching";
  $title.textContent = titleText || "";
  $tabs.classList.toggle("hidden", mode !== "email");
  $actions.classList.toggle("hidden", mode !== "email");
}

function renderEmail() {
  if (!state.emailResult) {
    $content.textContent = "";
    return;
  }
  const r = state.emailResult;
  if (state.activeTab === "summary") $content.textContent = r.summary || "(no summary)";
  else if (state.activeTab === "reply") $content.textContent = r.draftReply || "(no draft)";
  else if (state.activeTab === "ask")
    $content.textContent = r.clarifyingQuestion || "nothing to ask. it reads clear.";
}

function renderPdf() {
  $content.textContent = state.pdfResult || "";
}

function renderForMode() {
  if (state.mode === "email") renderEmail();
  else if (state.mode === "pdf") renderPdf();
}

const THINKING_LINES = ["...let me peek", "...one moment", "...reading", "hm, hold on", "...looking"];
function pickThinking() {
  return THINKING_LINES[Math.floor(Math.random() * THINKING_LINES.length)];
}

function fingerprint(ctx) {
  if (!ctx) return "";
  if (ctx.mode === "email" && ctx.mail) {
    return `mail:${ctx.mail.subject}|${ctx.mail.sender}|${ctx.mail.body.length}`;
  }
  if (ctx.mode === "pdf") return `pdf:${ctx.appName}|${ctx.title}`;
  return "idle";
}

const NO_READ_LINE = "I can't quite focus on this one. let me rest a moment.";
const NO_MAIL_LINE = "this letter's blurred for me right now. give me a minute.";

async function handleEmail(ctx) {
  setMode("email", ctx.mail.subject || "(no subject)");
  pokeAwake();
  $content.textContent = pickThinking();
  setSpinner(true);
  try {
    const r = (await cat.analyzeEmail(ctx.mail)) || {};
    state.emailResult = r;
    state.activeTab = "summary";
    $tabButtons.forEach((b) =>
      b.classList.toggle("active", b.dataset.tab === "summary")
    );
    const hasAny = (r.summary && r.summary.trim()) ||
                   (r.draftReply && r.draftReply.trim()) ||
                   (r.clarifyingQuestion && r.clarifyingQuestion.trim());
    if (!hasAny) {
      $content.textContent = NO_MAIL_LINE;
      flashAnnoyed();
    } else {
      renderEmail();
      perk();
      if (r.summary) speakAndShow(r.summary, { mode: "email" });
    }
  } catch (e) {
    console.error("[cat] email failed:", e?.message || e);
    $content.textContent = NO_MAIL_LINE;
    flashAnnoyed();
  } finally {
    setSpinner(false);
  }
}

async function handlePdf(ctx) {
  setMode("pdf", ctx.title || ctx.appName);
  pokeAwake();
  $content.textContent = pickThinking();
  setSpinner(true);
  try {
    const b64 = await cat.capturePrimary();
    const summary = await cat.summarizePdf(b64);
    state.pdfResult = summary;
    if (summary && summary.trim()) {
      renderPdf();
      perk();
      speakAndShow(summary, { mode: "pdf" });
    } else {
      $content.textContent = NO_READ_LINE;
      flashAnnoyed();
    }
  } catch (e) {
    console.error("[cat] pdf failed:", e?.message || e);
    $content.textContent = NO_READ_LINE;
    flashAnnoyed();
  } finally {
    setSpinner(false);
  }
}

// Tracks the user's foreground app/title across ALL modes (including idle),
// so the cat can react when the user switches windows even within idle.
let lastFrontKey = "";
let lastFrontReactionAt = 0;
const FRONT_REACTION_COOLDOWN_MS = 12000;

function reactToFrontSwitch(ctx) {
  const frontKey = `${ctx?.appName || ""}|${ctx?.title || ""}`;
  if (!frontKey || frontKey === lastFrontKey) return;
  const wasFirstSeen = lastFrontKey === "";
  lastFrontKey = frontKey;
  // Skip the very first sample on launch so we don't fire a reaction on init.
  if (wasFirstSeen) return;

  // Always give visible feedback that the cat noticed.
  pokeAwake();
  perk();

  // Rate-limit the chatty side: at most once per cooldown, kick the
  // autonomous tick so the cat can comment on what the user clicked into.
  const now = Date.now();
  if (now - lastFrontReactionAt < FRONT_REACTION_COOLDOWN_MS) return;
  lastFrontReactionAt = now;
  setTimeout(autonomousTick, 600);
}

async function activeTick(force) {
  if (state.activeBusy) return;
  let ctx;
  try {
    ctx = await cat.getContext();
  } catch (e) {
    console.warn("[cat] getContext failed:", e);
    return;
  }

  reactToFrontSwitch(ctx);

  const fp = fingerprint(ctx);
  if (!force && fp === state.activeFp) return;
  state.activeFp = fp;

  if (ctx.mode === "idle") {
    setMode("idle", "");
    hidePanel();
    return;
  }
  if (state.panelDismissed && !force) return;

  showPanel();
  state.activeBusy = true;
  try {
    if (ctx.mode === "email" && ctx.mail) await handleEmail(ctx);
    else if (ctx.mode === "pdf") await handlePdf(ctx);
  } finally {
    state.activeBusy = false;
  }
}

/* ---------- autonomous tick — proactive every cycle ---------- */
async function autonomousTick() {
  if (state.activeBusy || state.walking || state.playing || state.annoyed) return;
  if (Date.now() < state.speakingUntil) return;
  try {
    const offer = await cat.proactiveAssist();
    // Skip silently on empty or on repeat — never inject the fallback line in
    // an unsolicited cycle (only the user's click can pull a fallback).
    if (!offer || !offer.trim()) return;
    if (recentlySaid(offer)) {
      console.log("[cat] autonomous skipping repeat:", offer.slice(0, 50));
      return;
    }
    pokeAwake();
    perk();
    speakAndShow(offer, { mode: "curious" });
    try {
      const memory = (await cat.readMemory()) || { observations: [], session_count: 0 };
      memory.session_count = (memory.session_count || 0) + 1;
      memory.observations = memory.observations || [];
      memory.observations.push({
        at: new Date().toISOString(),
        tag: "proactive",
        said: offer,
      });
      if (memory.observations.length > 100) {
        memory.observations = memory.observations.slice(-100);
      }
      await cat.writeMemory(memory);
    } catch {}
  } catch (e) {
    console.warn("[cat] autonomous tick failed:", e?.message || e);
  }
}

/* ---------- mouse / drag / click ---------- */
let lastMouse = null;
let dragMoved = false;

$catWrapper.addEventListener("mousedown", (e) => {
  if (e.target === $settingsBtn || e.target === $micBtn) return;
  lastMouse = { x: e.screenX, y: e.screenY };
  dragMoved = false;
});

window.addEventListener("mouseup", () => {
  const wasClick = lastMouse && !dragMoved;
  lastMouse = null;
  if (!wasClick) return;
  // Visual ack on every click, even debounced — the user always sees response.
  pokeAwake();
  perk();
  // Refresh whatever active panel is visible; otherwise ask proactively.
  const panelOpen = !$panel.classList.contains("hidden");
  if (panelOpen && (state.mode === "pdf" || state.mode === "email")) {
    activeTick(true);
  } else {
    triggerProactiveAssist();
  }
});

let lastProactiveAt = 0;
let consecutiveEmpty = 0;
const CLICK_DEBOUNCE_MS = 1500;
async function triggerProactiveAssist() {
  const now = Date.now();
  if (now - lastProactiveAt < CLICK_DEBOUNCE_MS) {
    showBubble("mm. one moment.", 1500);
    return;
  }
  if (state.activeBusy) {
    showBubble("hold on, still reading.", 1500);
    return;
  }
  lastProactiveAt = now;
  showBubble("...let me look", 1400);
  setSpinner(true);
  try {
    let offer = await cat.proactiveAssist();
    // If the model echoed something we already said, ask once more.
    if (offer && recentlySaid(offer)) {
      console.log("[cat] proactive returned a repeat, retrying once");
      offer = await cat.proactiveAssist();
    }
    setSpinner(false);
    if (offer && offer.trim() && !recentlySaid(offer)) {
      consecutiveEmpty = 0;
      pokeAwake();
      perk();
      speakAndShow(offer, { mode: "curious" });
      return;
    }
    consecutiveEmpty++;
    if (consecutiveEmpty >= 2) {
      // Don't keep filling the bubble with fallback noise; just nod.
      perk();
      showBubble("...", 1200);
      return;
    }
    const fallback = pickFreshFallback();
    if (fallback) speakAndShow(fallback, { mode: "auto" });
    else { perk(); showBubble("...", 1200); }
  } catch (e) {
    setSpinner(false);
    console.warn("[cat] proactive failed:", e?.message || e);
    const fallback = pickFreshFallback();
    if (fallback) speakAndShow(fallback, { mode: "auto" });
  }
}

window.addEventListener("mousemove", (e) => {
  if (!lastMouse) return;
  const dx = e.screenX - lastMouse.x;
  const dy = e.screenY - lastMouse.y;
  if (dx || dy) {
    cat.dragWindow({ x: dx, y: dy });
    lastMouse = { x: e.screenX, y: e.screenY };
    if (Math.abs(dx) + Math.abs(dy) > 2) dragMoved = true;
  }
});

$catWrapper.addEventListener("mouseenter", () => {
  if (state.sprite === "sleep" || state.sprite === "puddle") {
    pokeAwake();
  }
});

/* ---------- panel interactions ---------- */
$tabButtons.forEach((b) =>
  b.addEventListener("click", () => {
    state.activeTab = b.dataset.tab;
    $tabButtons.forEach((x) => x.classList.toggle("active", x === b));
    renderForMode();
  })
);

$panelClose.addEventListener("click", () => {
  state.panelDismissed = true;
  hidePanel();
  stopAudio();
});

$copy.addEventListener("click", async () => {
  if (!state.emailResult) return;
  const r = state.emailResult;
  const text =
    state.activeTab === "reply"
      ? r.draftReply
      : state.activeTab === "ask"
        ? r.clarifyingQuestion
        : r.summary;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    $copy.textContent = "copied";
    setTimeout(() => ($copy.textContent = "Copy"), 1200);
  } catch {
    /* noop */
  }
});

/* ---------- settings ---------- */
async function loadSettings() {
  try {
    const s = await cat.getSettings();
    if (s) state.settings = { ...state.settings, ...s };
  } catch {}
  try {
    state.hasVoiceKey = await cat.hasVoiceKey();
  } catch {
    state.hasVoiceKey = false;
  }
  try {
    state.hasOllama = await cat.hasOllama();
  } catch {
    state.hasOllama = false;
  }
  reflectSettingsToUI();
}

function reflectSettingsToUI() {
  $voiceToggle.checked = !!state.settings.voiceEnabled;
  $voiceProfile.value = state.settings.voiceProfile || "soft";
  $autoVoice.checked = !!state.settings.autoVoiceByContext;
  $offlineToggle.checked = !!state.settings.offlineMode;

  if (!state.hasVoiceKey) {
    $voiceStatus.textContent = "no ELEVENLABS_API_KEY in .env — voice is disabled";
    $voiceStatus.classList.add("warn");
    $voiceToggle.disabled = true;
  } else {
    $voiceStatus.textContent = state.settings.voiceEnabled
      ? "voice on. she will speak when she has something to say."
      : "voice off. text only.";
    $voiceStatus.classList.remove("warn");
    $voiceToggle.disabled = false;
  }

  if (!state.hasOllama) {
    $offlineStatus.textContent =
      "Ollama not configured — set OLLAMA_ENABLED=true in .env and run `ollama serve`";
    $offlineStatus.classList.add("warn");
  } else if (state.settings.offlineMode) {
    $offlineStatus.textContent =
      "offline mode on — conversation runs on Ollama; screen-watching and PDF/email modes are paused (no local vision model).";
    $offlineStatus.classList.remove("warn");
  } else {
    $offlineStatus.textContent = "offline mode off. using cloud (OpenAI/Gemini).";
    $offlineStatus.classList.remove("warn");
  }
}

$settingsBtn.addEventListener("click", () => {
  $settingsOverlay.classList.remove("hidden");
});

$settingsClose.addEventListener("click", () => {
  $settingsOverlay.classList.add("hidden");
});

$voiceToggle.addEventListener("change", async (e) => {
  state.settings.voiceEnabled = e.target.checked;
  if (!e.target.checked) stopAudio();
  await cat.setSettings({ voiceEnabled: e.target.checked });
  reflectSettingsToUI();
});

$voiceProfile.addEventListener("change", async (e) => {
  state.settings.voiceProfile = e.target.value;
  await cat.setSettings({ voiceProfile: e.target.value });
  applyVoiceProfileLook(e.target.value);
});

function applyVoiceProfileLook(profile) {
  applyProfileColor(profile);
  applyProfileAnimation(profile);
  const look = VOICE_PROFILE_LOOK[profile];
  if (!look) return;
  if (state.walking || state.annoyed) return;
  if (look.sprite) setSprite(look.sprite);
  state.lastActiveAt = Date.now();
  perk();
  if (look.tagline) speakAndShow(look.tagline, { mode: "auto" });
}

$autoVoice.addEventListener("change", async (e) => {
  state.settings.autoVoiceByContext = e.target.checked;
  await cat.setSettings({ autoVoiceByContext: e.target.checked });
});

$offlineToggle.addEventListener("change", async (e) => {
  state.settings.offlineMode = e.target.checked;
  await cat.setSettings({ offlineMode: e.target.checked });
  reflectSettingsToUI();
});

/* ---------- random schedulers ---------- */
function scheduleNextWalk() {
  const next = (6 + Math.random() * 6) * 60 * 1000;
  setTimeout(() => {
    startWalkCycle();
    scheduleNextWalk();
  }, next);
}

function scheduleNextPlay() {
  const next = (15 + Math.random() * 10) * 60 * 1000;
  setTimeout(() => {
    startPlay();
    scheduleNextPlay();
  }, next);
}

/* ---------- microphone: user → cat conversation (MediaRecorder + Whisper) ---------- */
let mediaStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let listening = false;
let recordedMimeType = "audio/webm";

const MAX_RECORD_MS = 15000; // safety cap
let recordTimeout = null;

function setupMic() {
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    $micBtn.style.display = "none";
    console.warn("[cat] MediaRecorder not available — mic disabled.");
    return;
  }
  // Pick a mime the browser actually supports.
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  recordedMimeType =
    candidates.find((m) => MediaRecorder.isTypeSupported(m)) || "audio/webm";
}

function startListeningUI() {
  listening = true;
  $micBtn.classList.add("listening");
  $micBtn.textContent = "●";
  if ($micStatus) { $micStatus.textContent = "Listening..."; $micStatus.classList.add("mic-status-visible"); }
  pokeAwake();
  perk();
}

function stopListeningUI() {
  listening = false;
  $micBtn.classList.remove("listening");
  $micBtn.textContent = "🎙";
  if ($micStatus) { $micStatus.textContent = "Thinking..."; }
}

async function startRecording() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    console.warn("[cat] microphone permission denied:", e?.message || e);
    showBubble("I can't hear without microphone access.", 3500);
    return;
  }

  recordedChunks = [];
  try {
    mediaRecorder = new MediaRecorder(mediaStream, { mimeType: recordedMimeType });
  } catch {
    mediaRecorder = new MediaRecorder(mediaStream);
  }

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    const blob = new Blob(recordedChunks, { type: recordedMimeType });
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    stopListeningUI(); // sets $micStatus to "Thinking..."
    if (blob.size < 800) {
      // Probably silence — hide status and bail.
      if ($micStatus) $micStatus.classList.remove("mic-status-visible");
      return;
    }
    try {
      // Convert Blob → base64 via FileReader, then route through listener:stop
      // so listener.js can handle calendar intents and general cat replies together.
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          // data:audio/webm;base64,<BASE64> → extract after the comma
          const base64 = reader.result.split(",")[1];
          cat.listenerStart();
          await cat.listenerStop(base64);
          // Response arrives via the "listener:result" event handler below.
        } catch (e) {
          console.warn("[listener] listenerStop failed:", e?.message || e);
          if ($micStatus) $micStatus.classList.remove("mic-status-visible");
          showBubble("Sorry, I didn't catch that.", 2500);
        }
      };
      reader.onerror = () => {
        console.warn("[listener] FileReader error");
        if ($micStatus) $micStatus.classList.remove("mic-status-visible");
      };
      reader.readAsDataURL(blob);
    } catch (e) {
      console.warn("[listener] onstop exception:", e?.message || e);
      if ($micStatus) $micStatus.classList.remove("mic-status-visible");
    }
  };

  mediaRecorder.start();
  startListeningUI();

  // Auto-stop after MAX_RECORD_MS so a forgotten record session doesn't
  // hold the mic open forever.
  clearTimeout(recordTimeout);
  recordTimeout = setTimeout(() => {
    if (listening) stopRecording();
  }, MAX_RECORD_MS);
}

function stopRecording() {
  clearTimeout(recordTimeout);
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try {
      mediaRecorder.stop();
    } catch {}
  } else {
    stopListeningUI();
  }
}

async function handleUserSpeech(transcript) {
  if (!transcript || !transcript.trim()) return;
  showBubble("you: " + transcript, 4500);
  pokeAwake();
  perk();
  try {
    const reply = await cat.replyToUser(transcript);
    if (reply && reply.trim()) {
      setTimeout(() => speakAndShow(reply, { mode: "curious" }), 700);
    } else {
      setTimeout(() => speakAndShow("mm.", { mode: "auto" }), 700);
    }
  } catch (e) {
    console.warn("[cat] reply failed:", e?.message || e);
  }
}

$micBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (listening) stopRecording();
  else startRecording();
});

// Stop the wrapper drag handler from picking up mic clicks.
$micBtn.addEventListener("mousedown", (e) => e.stopPropagation());

/* ---------- listener result / error handlers ---------- */

if (cat.onListenerResult) {
  cat.onListenerResult((data) => {
    console.log("[listener] result:", data);
    if ($micStatus) $micStatus.classList.remove("mic-status-visible");
    if (data && data.response && data.response.trim()) {
      speakAndShow(data.response, { mode: "curious", allowRepeat: true });
    }
  });
}

if (cat.onListenerError) {
  cat.onListenerError((data) => {
    console.warn("[listener] error:", data?.message || data);
    if ($micStatus) $micStatus.classList.remove("mic-status-visible");
    $micBtn.classList.remove("listening");
    showBubble("Sorry, I didn't catch that.", 2500);
  });
}

/* ---------- keyboard shortcut: M toggles mic ---------- */

window.addEventListener("keydown", (e) => {
  if (e.key === "m" || e.key === "M") {
    // Only fire when no text input is focused.
    if (document.activeElement && document.activeElement.tagName === "INPUT") return;
    if (listening) stopRecording();
    else startRecording();
  }
});

/* ---------- mouse-question handler (from main process) ---------- */
function handleMouseQuestion(question) {
  if (!question || !question.trim()) return;
  if (state.activeBusy) return;
  if (Date.now() < state.speakingUntil) return;
  pokeAwake();
  perk();
  speakAndShow(question, { mode: "curious" });
}

/* ---------- init ---------- */
const GREETINGS = [
  "hello. I'm here.",
  "oh, you came back.",
  "mm. settled.",
  "I'm watching now.",
];

function warmupTTS() {
  if (!("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.addEventListener("voiceschanged", () => {
      const n = window.speechSynthesis.getVoices().length;
      console.log(`[cat] tts voices loaded: ${n}`);
    });
    // Silent warmup utterance — Chromium-based shells often need this once
    // before later .speak() calls actually produce audio.
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    window.speechSynthesis.speak(u);
  } catch (e) {
    console.warn("[cat] tts warmup failed:", e?.message || e);
  }
}

async function init() {
  await loadSettings();
  applyProfileColor(state.settings.voiceProfile);
  applyProfileAnimation(state.settings.voiceProfile);
  warmupTTS();
  state.lastActiveAt = Date.now() - PUDDLE_AFTER_AWAKE_MS;
  setSprite("puddle");

  setupMic();

  setInterval(maybeSleep, 4000);
  setInterval(tiltSometimes, 8500);
  setInterval(() => activeTick(false), ACTIVE_MS);
  setInterval(autonomousTick, AUTONOMOUS_MS);
  scheduleNextWalk();
  scheduleNextPlay();

  if (cat.onMouseQuestion) {
    cat.onMouseQuestion(handleMouseQuestion);
  }

  activeTick(true);
  setTimeout(autonomousTick, 2000);

  // Startup greeting so the user immediately knows voice works.
  setTimeout(() => {
    pokeAwake();
    perk();
    const line = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
    speakAndShow(line, { mode: "auto" });
  }, 1200);
}

init();
