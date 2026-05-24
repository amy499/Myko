/*
 * calendar.js
 *
 * What it does:  Provides a unified CalendarManager that aggregates multiple
 *                calendar providers (Google, Outlook) and exposes read/write
 *                operations plus voice-command parsing for the cat.
 *
 * Exports:       { CalendarManager, GoogleCalendarProvider, OutlookCalendarProvider }
 *
 * Env vars:      GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET  — Google OAuth2 desktop app credentials
 *                GOOGLE_REDIRECT_URI                      — optional, defaults to OOB redirect
 *                OUTLOOK_CLIENT_ID                        — Azure App Registration client ID
 *                OUTLOOK_TENANT_ID                        — optional, defaults to "common"
 *
 * Token storage: calendar_tokens.json in project root (gitignored)
 */

"use strict";

const fs = require("fs/promises");
const path = require("path");

const TOKEN_FILE = path.join(__dirname, "calendar_tokens.json");

/* ---------- token file helpers ---------- */

async function readTokenFile() {
  try {
    return JSON.parse(await fs.readFile(TOKEN_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function writeTokenFile(data) {
  await fs.writeFile(TOKEN_FILE, JSON.stringify(data, null, 2), "utf8");
}

/* ============================================================
   GoogleCalendarProvider
   ============================================================ */

class GoogleCalendarProvider {
  /*
   * @param {{ clientId: string, clientSecret: string, redirectUri?: string }} opts
   */
  constructor({ clientId, clientSecret, redirectUri }) {
    this.name = "google";
    this._connected = false;

    const { google } = require("googleapis");
    this._google = google;
    this.oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      redirectUri || "urn:ietf:wg:oauth:2.0:oob"
    );

    // Auto-save refreshed tokens so they persist across restarts.
    this.oauth2Client.on("tokens", async (tokens) => {
      console.log("[calendar] Google tokens refreshed — saving");
      try {
        const all = await readTokenFile();
        all.google = { ...(all.google || {}), ...tokens };
        await writeTokenFile(all);
      } catch (e) {
        console.error("[calendar] Failed to save refreshed Google tokens:", e.message);
      }
    });
  }

  get isConnected() {
    return this._connected;
  }

  /* Load saved credentials. Returns true on success. */
  async _loadCredentials() {
    try {
      const all = await readTokenFile();
      if (all.google && (all.google.access_token || all.google.refresh_token)) {
        this.oauth2Client.setCredentials(all.google);
        this._connected = true;
        return true;
      }
    } catch (e) {
      console.error("[calendar] Google _loadCredentials failed:", e.message);
    }
    return false;
  }

  /* Returns the OAuth2 URL the user must visit to authorize. */
  getAuthUrl() {
    return this.oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: ["https://www.googleapis.com/auth/calendar"],
      prompt: "consent",
    });
  }

  /* Exchange the authorization code returned by Google for tokens. */
  async handleAuthCode(code) {
    try {
      const { tokens } = await this.oauth2Client.getToken(code);
      this.oauth2Client.setCredentials(tokens);
      const all = await readTokenFile();
      all.google = tokens;
      await writeTokenFile(all);
      this._connected = true;
      console.log("[calendar] Google authorization complete");
    } catch (e) {
      console.error("[calendar] Google handleAuthCode failed:", e.message);
      throw e;
    }
  }

  /* Returns normalized event objects for the next `days` days. */
  async readUpcoming(days = 7) {
    if (!(await this._loadCredentials())) return [];
    try {
      const cal = this._google.calendar({ version: "v3", auth: this.oauth2Client });
      const now = new Date();
      const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
      const res = await cal.events.list({
        calendarId: "primary",
        timeMin: now.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 50,
      });
      return (res.data.items || []).map((e) => ({
        id: e.id,
        title: e.summary || "(no title)",
        start: e.start?.dateTime ? new Date(e.start.dateTime) : new Date(e.start.date),
        end: e.end?.dateTime ? new Date(e.end.dateTime) : new Date(e.end.date),
        location: e.location || null,
        description: e.description || null,
        provider: "google",
      }));
    } catch (e) {
      console.error("[calendar] Google readUpcoming failed:", e.message);
      return [];
    }
  }

  /* Creates a new calendar event. */
  async writeEvent({ title, start, end, description, location }) {
    if (!(await this._loadCredentials())) return null;
    try {
      const cal = this._google.calendar({ version: "v3", auth: this.oauth2Client });
      const event = {
        summary: title,
        start: { dateTime: start instanceof Date ? start.toISOString() : start },
        end: { dateTime: end instanceof Date ? end.toISOString() : end },
      };
      if (description) event.description = description;
      if (location) event.location = location;
      const res = await cal.events.insert({ calendarId: "primary", resource: event });
      console.log("[calendar] Google event created:", res.data.id);
      return res.data;
    } catch (e) {
      console.error("[calendar] Google writeEvent failed:", e.message);
      return null;
    }
  }
}

/* ============================================================
   OutlookCalendarProvider
   ============================================================ */

class OutlookCalendarProvider {
  /*
   * @param {{ clientId: string, tenantId?: string }} opts
   */
  constructor({ clientId, tenantId }) {
    this.name = "outlook";
    this._connected = false;
    this._accessToken = null;

    const msal = require("@azure/msal-node");
    this.pca = new msal.PublicClientApplication({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId || "common"}`,
      },
    });
  }

  get isConnected() {
    return this._connected;
  }

  async _loadCredentials() {
    try {
      const all = await readTokenFile();
      if (all.outlook && all.outlook.access_token) {
        this._accessToken = all.outlook.access_token;
        this._connected = true;
        return true;
      }
    } catch (e) {
      console.error("[calendar] Outlook _loadCredentials failed:", e.message);
    }
    return false;
  }

  /*
   * Triggers the MSAL device-code flow. Opens the verification URL in the
   * system browser and calls onCodeReady(message, userCode, verificationUri).
   */
  async connect(onCodeReady) {
    try {
      const response = await this.pca.acquireTokenByDeviceCode({
        scopes: ["Calendars.ReadWrite", "offline_access"],
        deviceCodeCallback: (resp) => {
          const { message, userCode, verificationUri } = resp;
          console.log("[calendar] Outlook device code:", userCode, verificationUri);
          if (onCodeReady) onCodeReady(message, userCode, verificationUri);
          try {
            const { shell } = require("electron");
            shell.openExternal(verificationUri);
          } catch {
            // Not in Electron context — user must open URL manually.
          }
        },
      });

      if (response && response.accessToken) {
        this._accessToken = response.accessToken;
        this._connected = true;
        const all = await readTokenFile();
        all.outlook = {
          access_token: response.accessToken,
          expires_at: response.expiresOn ? response.expiresOn.toISOString() : null,
        };
        await writeTokenFile(all);
        console.log("[calendar] Outlook authorization complete");
      }
    } catch (e) {
      console.error("[calendar] Outlook connect failed:", e.message);
    }
  }

  async _graphFetch(endpoint, opts = {}) {
    if (!this._accessToken) await this._loadCredentials();
    if (!this._accessToken) throw new Error("Outlook not connected");

    const res = await fetch(`https://graph.microsoft.com/v1.0${endpoint}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${this._accessToken}`,
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Graph API ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  async readUpcoming(days = 7) {
    try {
      const now = new Date();
      const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
      const params = new URLSearchParams({
        startDateTime: now.toISOString(),
        endDateTime: end.toISOString(),
        $orderby: "start/dateTime",
        $select: "id,subject,start,end,location,bodyPreview",
        $top: "50",
      });
      const data = await this._graphFetch(`/me/calendarview?${params}`);
      return (data.value || []).map((e) => ({
        id: e.id,
        title: e.subject || "(no title)",
        start: new Date(e.start?.dateTime || e.start),
        end: new Date(e.end?.dateTime || e.end),
        location: e.location?.displayName || null,
        description: e.bodyPreview || null,
        provider: "outlook",
      }));
    } catch (e) {
      console.error("[calendar] Outlook readUpcoming failed:", e.message);
      return [];
    }
  }

  async writeEvent({ title, start, end, description, location }) {
    try {
      const body = {
        subject: title,
        start: { dateTime: (start instanceof Date ? start : new Date(start)).toISOString(), timeZone: "UTC" },
        end: { dateTime: (end instanceof Date ? end : new Date(end)).toISOString(), timeZone: "UTC" },
      };
      if (description) body.body = { contentType: "Text", content: description };
      if (location) body.location = { displayName: location };
      const res = await this._graphFetch("/me/events", {
        method: "POST",
        body: JSON.stringify(body),
      });
      console.log("[calendar] Outlook event created:", res.id);
      return res;
    } catch (e) {
      console.error("[calendar] Outlook writeEvent failed:", e.message);
      return null;
    }
  }
}

/* ============================================================
   CalendarManager
   ============================================================ */

class CalendarManager {
  constructor() {
    this._providers = [];
  }

  /* Add a provider instance. */
  register(provider) {
    this._providers.push(provider);
    console.log(`[calendar] registered provider: ${provider.name}`);
  }

  /* Returns providers whose isConnected getter returns true. */
  getConnectedProviders() {
    return this._providers.filter((p) => p.isConnected);
  }

  /* Reads from all providers, merges, and sorts by start time. */
  async readAllUpcoming(days = 7) {
    const results = await Promise.all(this._providers.map((p) => p.readUpcoming(days)));
    const merged = results.flat();
    return merged.sort((a, b) => a.start - b.start);
  }

  /* Writes an event to the named provider. */
  async writeEvent(providerName, eventData) {
    const provider = this._providers.find((p) => p.name === providerName);
    if (!provider) throw new Error(`[calendar] No provider named "${providerName}"`);
    return provider.writeEvent(eventData);
  }

  /*
   * Returns a short plain-text string of events within hoursAhead, or null
   * if there are none. Format: "- "title" in Xh Ym (provider)"
   */
  async getContextSummary(hoursAhead = 24) {
    try {
      const days = Math.ceil(hoursAhead / 24);
      const events = await this.readAllUpcoming(days);
      if (!events || events.length === 0) return null;

      const now = Date.now();
      const cutoff = now + hoursAhead * 60 * 60 * 1000;
      const upcoming = events.filter((e) => e.start instanceof Date && e.start.getTime() <= cutoff);
      if (upcoming.length === 0) return null;

      return upcoming
        .map((e) => {
          const diffMs = e.start.getTime() - now;
          const diffH = Math.floor(diffMs / 3_600_000);
          const diffM = Math.floor((diffMs % 3_600_000) / 60_000);
          const timeStr = diffH > 0 ? `${diffH}h ${diffM}m` : `${diffM}m`;
          return `- "${e.title}" in ${timeStr} (${e.provider})`;
        })
        .join("\n");
    } catch (e) {
      console.error("[calendar] getContextSummary failed:", e.message);
      return null;
    }
  }

  /*
   * Parses a natural-language transcript into a structured intent object.
   * Returns { intent: "read_calendar"|"add_event"|"unknown", params: {...} }
   */
  parseVoiceCommand(transcript) {
    const t = (transcript || "").toLowerCase().trim();

    // --- read_calendar intent ---
    const readPattern =
      /\b(check|show|list|read|what(?:'s| is)|tell me|any|upcoming|see)\b.{0,30}(calendar|event|meeting|schedule|today|tomorrow|week)/i;
    if (readPattern.test(t)) {
      return { intent: "read_calendar", params: {} };
    }
    // fallback: bare mention of calendar
    if (/\bcalendar\b/.test(t) && /\b(what|any|show|check|list|upcoming)\b/.test(t)) {
      return { intent: "read_calendar", params: {} };
    }

    // --- add_event intent ---
    const addPattern =
      /\b(add|create|schedule|set up|book|put)\b.{0,40}(meeting|event|appointment|call|lunch|dinner|breakfast|coffee|reminder|session|review)/i;
    if (addPattern.test(t) || /\b(add|create|schedule|book)\b/.test(t)) {
      // Extract title: noun phrase following the verb
      let title = null;
      const titleMatch = t.match(
        /(?:add|create|schedule|book|set up|put)\s+(?:a\s+|an\s+)?(.+?)(?:\s+(?:on|at|for|tomorrow|today|next|this)\b|$)/i
      );
      if (titleMatch) title = titleMatch[1].trim() || null;

      // Extract date
      let date = null;
      if (/\btoday\b/.test(t)) {
        date = new Date().toISOString().split("T")[0];
      } else if (/\btomorrow\b/.test(t)) {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        date = d.toISOString().split("T")[0];
      } else {
        const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
        const dayMatch = t.match(/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
        if (dayMatch) {
          const target = dayNames.indexOf(dayMatch[1].toLowerCase());
          const d = new Date();
          const diff = ((target - d.getDay() + 7) % 7) || 7;
          d.setDate(d.getDate() + diff);
          date = d.toISOString().split("T")[0];
        }
      }

      // Extract time (e.g. "3pm", "10:30am")
      let time = null;
      const timeMatch = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
      if (timeMatch) {
        let h = parseInt(timeMatch[1], 10);
        const m = parseInt(timeMatch[2] || "0", 10);
        const meridiem = timeMatch[3].toLowerCase();
        if (meridiem === "pm" && h < 12) h += 12;
        if (meridiem === "am" && h === 12) h = 0;
        time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      }

      // Extract duration in minutes
      let duration = null;
      const durMatch = t.match(/\b(\d+)\s*(hour|hr|minute|min)s?\b/i);
      if (durMatch) {
        duration = parseInt(durMatch[1], 10) * (/hour|hr/i.test(durMatch[2]) ? 60 : 1);
      }

      return { intent: "add_event", params: { title, date, time, duration } };
    }

    return { intent: "unknown", params: {} };
  }
}

module.exports = { CalendarManager, GoogleCalendarProvider, OutlookCalendarProvider };
