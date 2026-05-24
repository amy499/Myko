/*
 * listener.js
 *
 * What it does:  Registers Electron IPC handlers for the microphone voice-command
 *                pipeline. Receives base64-encoded audio from the renderer,
 *                transcribes it via brain.transcribeAudio (OpenAI Whisper), then
 *                dispatches on the detected calendar intent. Sends "listener:result"
 *                or "listener:error" back to the renderer window.
 *
 * Exports:       setCalendar(cal) — injects the CalendarManager instance (called
 *                                   from main.js after calendar is initialized)
 *
 * IPC channels (main-process side):
 *   Handles:  "listener:start"  — renderer signals recording began
 *             "listener:stop"   — renderer sends base64 audio; returns result obj
 *   Sends:    "listener:result" — { transcript, intent, params, response }
 *             "listener:error"  — { message }
 *
 * Env vars:  Inherits OPENAI_API_KEY requirement from brain.js (for Whisper).
 */

"use strict";

const brain = require("./brain");
const { speakWithQwen3, isQwen3Available } = require("./voice");

/* ---------- lazy Electron binding (guards smoke-test imports) ---------- */

let ipcMain = { handle: () => {}, on: () => {} };
let BrowserWindow = { getAllWindows: () => [] };

try {
  const electron = require("electron");
  // Outside Electron, require('electron') returns the binary path string.
  if (electron && typeof electron === "object" && electron.ipcMain) {
    ipcMain = electron.ipcMain;
    BrowserWindow = electron.BrowserWindow;
  } else {
    console.warn("[listener] Not running inside Electron — IPC handlers not registered");
  }
} catch {
  console.warn("[listener] electron module not available — IPC handlers not registered");
}

/* ---------- mutable context (set by main.js after init) ---------- */

let _calendar = null;

/* Inject the CalendarManager instance. Must be called from main.js. */
function setCalendar(cal) {
  _calendar = cal;
  console.log("[listener] CalendarManager attached");
}

/* Safe reference to the first BrowserWindow at call time. */
function getWin() {
  const wins = BrowserWindow.getAllWindows();
  return wins.length > 0 ? wins[0] : null;
}

/* ---------- IPC: recording started ---------- */

ipcMain.on("listener:start", (_e) => {
  console.log("[listener] recording started");
});

/* ---------- IPC: audio arrived — transcribe + dispatch ---------- */

ipcMain.handle("listener:stop", async (_e, base64Audio) => {
  console.log("[listener] audio received — transcribing...");
  const win = getWin();

  const sendError = (message) => {
    console.error("[listener] error:", message);
    if (win) win.webContents.send("listener:error", { message });
  };

  try {
    if (!base64Audio) {
      sendError("No audio data received.");
      return null;
    }

    // Decode base64 → Buffer for brain.transcribeAudio.
    const buf = Buffer.from(base64Audio, "base64");
    const transcribeResult = await brain.transcribeAudio(buf, "audio/webm");

    if (!transcribeResult || !transcribeResult.ok || !transcribeResult.text) {
      const reason = transcribeResult?.reason || "unknown";
      sendError(
        reason === "no-api-key"
          ? "I need an OPENAI_API_KEY to hear you."
          : `Transcription failed: ${reason}`
      );
      return null;
    }

    const transcript = transcribeResult.text.trim();
    console.log("[listener] transcript:", transcript);

    // Parse calendar intent.
    let intent = "unknown";
    let params = {};
    if (_calendar) {
      const parsed = _calendar.parseVoiceCommand(transcript);
      intent = parsed.intent;
      params = parsed.params || {};
    }
    console.log("[listener] intent:", intent, params);

    let response = "";

    if (intent === "read_calendar" && _calendar) {
      const events = await _calendar.readAllUpcoming(7);
      if (!events || events.length === 0) {
        response = "You have nothing coming up in the next week.";
      } else {
        const next = events[0];
        const diffMs = next.start.getTime() - Date.now();
        const diffH = Math.floor(diffMs / 3_600_000);
        const diffM = Math.floor((diffMs % 3_600_000) / 60_000);
        const timeStr = diffH > 0 ? `${diffH}h ${diffM}m` : `${diffM}m`;
        const count = events.length;
        response = `You have ${count} event${count > 1 ? "s" : ""} coming up. Next is "${next.title}" in ${timeStr}.`;
      }
    } else if (intent === "add_event" && _calendar) {
      if (params.title) {
        try {
          const providers = _calendar.getConnectedProviders();
          if (providers.length > 0) {
            const startDate = params.date
              ? new Date(params.date)
              : new Date(Date.now() + 24 * 60 * 60 * 1000);
            if (params.time) {
              const [h, m] = params.time.split(":").map(Number);
              startDate.setHours(h || 9, m || 0, 0, 0);
            } else {
              startDate.setHours(9, 0, 0, 0);
            }
            const durationMs = (params.duration || 60) * 60_000;
            const endDate = new Date(startDate.getTime() + durationMs);
            await _calendar.writeEvent(providers[0].name, {
              title: params.title,
              start: startDate,
              end: endDate,
            });
            response = `Done. I have added "${params.title}" to your calendar.`;
          } else {
            response = "I did not catch enough details. Can you try again?";
          }
        } catch (e) {
          console.error("[listener] add_event write failed:", e.message);
          response = "I did not catch enough details. Can you try again?";
        }
      } else {
        response = "I did not catch enough details. Can you try again?";
      }
    } else {
      // Unknown intent — fall through to the cat's general reply.
      try {
        const reply = await brain.replyToUser(transcript);
        response = reply && reply.trim() ? reply : "mm.";
      } catch (e) {
        console.error("[listener] replyToUser failed:", e.message);
        response = "mm.";
      }
    }

    const result = { transcript, intent, params, response };
    if (win) win.webContents.send("listener:result", result);

    // Speak the response via Qwen3 if available (fire-and-forget).
    if (response) {
      if (isQwen3Available()) {
        speakWithQwen3(response).catch((e) =>
          console.error("[listener] Qwen3 speak failed:", e.message)
        );
      }
    }

    return result;
  } catch (e) {
    sendError(e.message || "Unexpected error in listener");
    return null;
  }
});

module.exports = { setCalendar };
