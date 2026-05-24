/*
 * voice.js
 *
 * What it does:  Provides Qwen3 TTS (Alibaba DashScope) as Myko's voice output,
 *                with automatic system-TTS fallback when the API key is absent.
 *                Audio is fetched as binary, written to a temp file, played via
 *                platform-appropriate system player, then deleted.
 *
 * Exports:       speakWithQwen3(text, options?)  — async, never throws
 *                isQwen3Available()              — sync boolean
 *
 * Env vars:      DASHSCOPE_API_KEY — Alibaba DashScope international key.
 *                                    Without it, falls back to system TTS.
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs/promises");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileP = promisify(execFile);

const DASHSCOPE_URL =
  "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/text2speech";

/* Returns true when the Qwen3 TTS API key is configured. */
function isQwen3Available() {
  return Boolean(process.env.DASHSCOPE_API_KEY);
}

/*
 * Speaks `text` using Qwen3 TTS if DASHSCOPE_API_KEY is set,
 * otherwise falls back to the platform system TTS.
 *
 * @param {string} text
 * @param {{ voice?: string, language?: string }} options
 */
async function speakWithQwen3(text, options = {}) {
  if (!text || !text.trim()) return;

  if (!isQwen3Available()) {
    console.log("[voice] DASHSCOPE_API_KEY not set — using system TTS fallback");
    return _fallbackTTS(text);
  }

  const voice = options.voice || "Cherry";
  const language = options.language || "en";
  const tmpFile = path.join(os.tmpdir(), `myko_speech_${Date.now()}.mp3`);

  try {
    const res = await fetch(DASHSCOPE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        model: "qwen3-tts-flash",
        input: { text },
        parameters: { voice, language_type: language },
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("[voice] Qwen3 API error:", res.status, errText.slice(0, 200));
      return _fallbackTTS(text);
    }

    const audioBuf = Buffer.from(await res.arrayBuffer());
    if (audioBuf.length === 0) {
      console.warn("[voice] Qwen3 returned empty audio — falling back");
      return _fallbackTTS(text);
    }

    await fs.writeFile(tmpFile, audioBuf);
    console.log("[voice] Qwen3 audio saved:", tmpFile);
    await _playFile(tmpFile);
  } catch (e) {
    console.error("[voice] speakWithQwen3 failed:", e.message);
    try { await _fallbackTTS(text); } catch {}
  } finally {
    try { await fs.unlink(tmpFile); } catch {}
  }
}

/* Play a file using the platform audio player. */
async function _playFile(filePath) {
  try {
    if (process.platform === "win32") {
      // PresentationCore MediaPlayer — handles MP3 natively on Windows.
      const script = [
        "Add-Type -AssemblyName presentationCore;",
        `$p = New-Object system.windows.media.mediaplayer;`,
        `$p.open('${filePath.replace(/'/g, "''")}');`,
        `$p.Play();`,
        `Start-Sleep -s 10`,
      ].join(" ");
      await execFileP("powershell", ["-NonInteractive", "-c", script], {
        timeout: 15000,
      });
    } else {
      await execFileP("afplay", [filePath], { timeout: 60000 });
    }
  } catch (e) {
    console.error("[voice] _playFile failed:", e.message);
  }
}

/* Platform system TTS — used when no API key or API call fails. */
async function _fallbackTTS(text) {
  const safe = (text || "").replace(/'/g, "''");
  try {
    if (process.platform === "win32") {
      const script = [
        "Add-Type -AssemblyName System.Speech;",
        `(New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${safe}')`,
      ].join(" ");
      await execFileP("powershell", ["-NonInteractive", "-c", script], {
        timeout: 30000,
      });
    } else {
      await execFileP("say", [text], { timeout: 60000 });
    }
  } catch (e) {
    console.error("[voice] fallback TTS failed:", e.message);
  }
}

module.exports = { speakWithQwen3, isQwen3Available };
