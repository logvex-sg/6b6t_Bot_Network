const logEl = document.getElementById("log");
const keys = { forward: false, back: false, left: false, right: false, jump: false, sneak: false, sprint: false };
const keyMap = {
  KeyW: "forward",
  KeyS: "back",
  KeyA: "left",
  KeyD: "right",
  Space: "jump",
  ShiftLeft: "sneak",
  ShiftRight: "sneak",
  KeyR: "sprint",
};

let status = null;
let lastControl = "";
let lastFaultAt = "";
let lastCaptchaKey = "";
let lastNotifiedCaptchaKey = "";
let swRegistration = null;
let fleetState = null;
/**
 * Selected profile is per browser tab:
 * 1) ?profile=<id> (or ?botId=) in the URL — open each profile in its own tab
 * 2) sessionStorage for this tab only (refresh keeps selection; other tabs unaffected)
 */
function readProfileIdFromUrl() {
  try {
    const params = new URLSearchParams(location.search);
    return (params.get("profile") || params.get("botId") || "").trim();
  } catch {
    return "";
  }
}

function writeProfileIdToUrl(id) {
  try {
    const url = new URL(location.href);
    if (id) {
      url.searchParams.set("profile", id);
      url.searchParams.delete("botId");
    } else {
      url.searchParams.delete("profile");
      url.searchParams.delete("botId");
    }
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  } catch {
    /* ignore */
  }
}

function profileTabUrl(id) {
  try {
    const url = new URL(location.href);
    if (id) {
      url.searchParams.set("profile", id);
      url.searchParams.delete("botId");
    }
    return url.pathname + url.search + url.hash;
  } catch {
    return `?profile=${encodeURIComponent(id || "")}`;
  }
}

let selectedBotId = "";
try {
  selectedBotId = readProfileIdFromUrl() || sessionStorage.getItem("fractal-bot-id") || "";
} catch {
  selectedBotId = readProfileIdFromUrl() || "";
}

function token() {
  const params = new URLSearchParams(location.search);
  return params.get("token") || localStorage.getItem("control-token") || "";
}

function headers() {
  const t = token();
  return t ? { authorization: `Bearer ${t}`, "content-type": "application/json" } : { "content-type": "application/json" };
}

async function rpc(action, extra = {}) {
  const fleetActions = new Set([
    "fleetStatus",
    "fleetAccounts",
    "fleetAddAccount",
    "fleetRemoveAccount",
    "fleetStart",
    "fleetStop",
    "fleetStartAll",
    "fleetStopAll",
    "fleetSetTask",
    "getSettings",
    "saveSettings",
    "catalog",
  ]);
  const payload = { action, ...extra };
  if (!fleetActions.has(action) && typeof selectedBotId === "string" && selectedBotId) {
    payload.botId = selectedBotId;
  }
  const res = await fetch("/v1/rpc", {
    method: "POST",
    credentials: "same-origin",
    headers: headers(),
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!body.ok) push("err", body.error || "request failed");
  return body;
}

function fmtUptime(ms) {
  const s = Math.floor((ms || 0) / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${s % 60}s`;
}

function setBar(id, value, max = 20) {
  const pct = Math.max(0, Math.min(100, ((value ?? 0) / max) * 100));
  document.querySelector(`#${id} i`).style.width = `${pct}%`;
  document.getElementById(`${id}-n`).textContent = value == null ? "—" : `${value}/${max}`;
}

let lastMapCovered = null;
let lastMapProgressAt = 0;
const STALL_MS = 10 * 60 * 1000;
const activityEntries = [];

function setPill(el, text, tone) {
  if (!el) return;
  el.textContent = text;
  el.dataset.tone = tone || "neutral";
  el.classList.add("pill");
}

function phaseTone(phase, lastError) {
  if (phase === "in_game") return "live";
  if (phase === "lobby" || phase === "authenticating" || phase === "connecting") return "busy";
  if (phase === "reconnecting") return "warn";
  if (phase === "disconnected" || lastError) return "critical";
  return "neutral";
}

/** Local clock time (user timezone), HH:MM:SS */
function fmtLocalTime(d = new Date()) {
  try {
    return new Date(d).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return new Date(d).toTimeString().slice(0, 8);
  }
}

/** Parse ISO / epoch / Date into local time string */
function fmtLocalFrom(value) {
  if (value == null || value === "") return "";
  if (typeof value === "number") return fmtLocalTime(new Date(value));
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    // Already a bare HH:MM:SS — leave it
    if (/^\d{2}:\d{2}:\d{2}/.test(String(value))) return String(value).slice(0, 8);
    return String(value);
  }
  return fmtLocalTime(d);
}

function logActivity(text) {
  const line = `${fmtLocalTime()} ${text}`;
  activityEntries.unshift(line);
  if (activityEntries.length > 80) activityEntries.length = 80;
  const ol = document.getElementById("activity-log");
  if (!ol) return;
  ol.replaceChildren();
  for (const entry of activityEntries.slice(0, 40)) {
    const li = document.createElement("li");
    li.textContent = entry;
    ol.append(li);
  }
}

function renderJobs(data) {
  const mapping = data.mapping || {};
  const m = mapping.mapping || mapping;
  const active = Boolean(mapping.active || m.active);
  const covered = Number(m.covered ?? m.coveredCells ?? NaN);
  const waypoints = Number(m.waypoints ?? m.total ?? NaN);
  const mode = m.mode || mapping.config?.mode || "—";
  const outDir = mapping.output?.dir || mapping.output?.regionsDir || "—";

  setPill(document.getElementById("map-active-pill"), active ? "active" : "idle", active ? "live" : "neutral");
  const modeEl = document.getElementById("map-mode-label");
  if (modeEl) modeEl.textContent = `mode ${mode}`;
  const prog = document.getElementById("map-progress");
  if (prog) {
    if (Number.isFinite(covered) && Number.isFinite(waypoints) && waypoints > 0) {
      const pct = Math.round((covered / waypoints) * 100);
      prog.textContent = `covered ${covered} / ${waypoints} (${pct}%)`;
    } else {
      prog.textContent = active ? "covered — (waiting for stats)" : "covered — / —";
    }
  }
  const outEl = document.getElementById("map-output");
  if (outEl) outEl.textContent = `output ${outDir}`;

  // Stall: active mapping but covered unchanged for STALL_MS
  const stallEl = document.getElementById("map-stall");
  if (active && Number.isFinite(covered)) {
    if (lastMapCovered !== covered) {
      lastMapCovered = covered;
      lastMapProgressAt = Date.now();
    } else if (!lastMapProgressAt) {
      lastMapProgressAt = Date.now();
    }
    const stalled = Date.now() - lastMapProgressAt > STALL_MS;
    if (stallEl) stallEl.hidden = !stalled;
  } else {
    lastMapCovered = null;
    lastMapProgressAt = 0;
    if (stallEl) stallEl.hidden = true;
  }

}

function renderAlerts(data) {
  const bar = document.getElementById("alerts-bar");
  if (!bar) return;
  const alerts = [];
  if (data.lastKickKind === "captcha" || (data.lastKickLinks && data.lastKickLinks.length)) {
    alerts.push({
      tone: "critical",
      text: `Captcha${data.lastVerificationCode ? ` code ${data.lastVerificationCode}` : ""} — solve and rejoin`,
    });
  } else if (data.lastKickKind === "rate-limit") {
    alerts.push({ tone: "warn", text: "Rate-limit kick — backing off before reconnect" });
  }
  if (data.phase === "disconnected" || data.phase === "reconnecting") {
    alerts.push({ tone: "warn", text: `Connection: ${data.phase}` });
  }
  if (data.lastError?.message && data.phase !== "in_game") {
    alerts.push({ tone: "critical", text: data.lastError.message.slice(0, 160) });
  }
  const stallEl = document.getElementById("map-stall");
  if (stallEl && !stallEl.hidden) {
    alerts.push({ tone: "warn", text: "Elytra mapper stall — no coverage progress for ~10 min" });
  }
  // Fleet-level: any bot with captcha from fleet state
  if (fleetState?.bots) {
    for (const b of fleetState.bots) {
      if (b.bot?.lastKickKind === "captcha") {
        alerts.push({ tone: "critical", text: `${b.username}: captcha` });
      }
    }
  }

  if (!alerts.length) {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }
  bar.hidden = false;
  bar.replaceChildren();
  for (const a of alerts) {
    const div = document.createElement("div");
    div.className = `alert alert-${a.tone}`;
    div.textContent = a.text;
    bar.append(div);
  }
}

function renderOpsStrip(data) {
  const el = document.getElementById("ops-summary");
  if (!el) return;
  const mapping = data.mapping || {};
  const m = mapping.mapping || mapping;
  const active = Boolean(mapping.active || m.active);
  const covered = m.covered ?? "—";
  const waypoints = m.waypoints ?? "—";
  const fleetN = fleetState?.bots?.length ?? 0;
  const online = fleetState?.bots?.filter((b) => b.running || b.bot?.connected).length ?? (data.connected ? 1 : 0);
  const kick = data.lastKickKind || "none";
  el.textContent = [
    `fleet ${online}/${fleetN}`,
    `phase ${data.phase || "—"}`,
    `world ${data.worldKind || "—"}`,
    active ? `map ${covered}/${waypoints}` : "map off",
    `kick ${kick}`,
  ].join(" · ");

  // Compact vitals in ops strip for the active profile
  const vitals = document.getElementById("ops-vitals");
  if (vitals) {
    const hasProfile = Boolean(selectedBotId);
    vitals.hidden = !hasProfile;
    if (hasProfile) {
      const worldEl = document.getElementById("ops-world");
      const xyzEl = document.getElementById("ops-xyz");
      const hpEl = document.getElementById("ops-hp");
      const foodEl = document.getElementById("ops-food");
      const pingEl = document.getElementById("ops-ping");
      if (worldEl) worldEl.textContent = data.worldKind || "—";
      if (xyzEl) {
        xyzEl.textContent = data.position
          ? `${Math.round(data.position.x)} ${Math.round(data.position.y)} ${Math.round(data.position.z)}`
          : "—";
      }
      if (hpEl) hpEl.textContent = data.health != null ? String(data.health) : "—";
      if (foodEl) foodEl.textContent = data.food != null ? String(data.food) : "—";
      if (pingEl) pingEl.textContent = data.ping == null ? "—" : `${data.ping}ms`;
    }
  }
}

function renderStatus(data) {
  status = data;
  window.__fractalStatus = data;
  if (data?.username && data?.skinUrl) rememberSkinUrl(data.username, data.skinUrl);
  // Keep inventory figure in sync when status (incl. cracked skin) arrives
  try { updateInventorySkin(); } catch { /* icons may load later */ }
  const phase = document.getElementById("phase");
  setPill(phase, data.phase || "idle", phaseTone(data.phase, data.lastError));
  document.getElementById("world").textContent = data.worldKind || "—";
  document.getElementById("dimension").textContent = data.dimension || "—";
  document.getElementById("xyz").textContent = data.position
    ? `${data.position.x.toFixed(1)}  ${data.position.y.toFixed(1)}  ${data.position.z.toFixed(1)}`
    : "—";
  document.getElementById("ping").textContent = data.ping == null ? "—" : `${data.ping} ms`;
  document.getElementById("tab").textContent = String(data.players ?? "—");
  document.getElementById("uptime").textContent = fmtUptime(data.uptimeMs);
  setBar("hp", data.health);
  setBar("food", data.food);
  // Connection switches are manual-only — never overwrite while user is controlling them
  const rc = document.getElementById("toggle-reconnect");
  if (rc && !connectionSwitchLocked("reconnect") && rc.dataset.userTouched !== "1") {
    rc.checked = Boolean(data.autoReconnect);
    rc.closest(".task-toggle")?.classList.toggle("on", rc.checked);
  }
  const lb = document.getElementById("toggle-lobby");
  if (lb && !connectionSwitchLocked("lobby") && lb.dataset.userTouched !== "1") {
    lb.checked = Boolean(data.autoLobby);
    lb.closest(".task-toggle")?.classList.toggle("on", lb.checked);
  }
  // Captcha notify is client-local only — never driven by bot status
  syncNotifyToggleUi();
  const huntEl = document.getElementById("hunt-state");
  if (huntEl) huntEl.textContent = data.huntingPortal ? "hunt on" : "hunt off";
  const fault = document.getElementById("fault");
  const info = data.lastError;
  if (fault) {
    if (info?.message) {
      const when = info.at ? fmtLocalFrom(info.at) : "";
      const code = info.code ? ` [${info.code}]` : "";
      fault.hidden = false;
      fault.textContent = `${when} ${info.source}${code}: ${info.message}`.trim();
      if (info.at && info.at !== lastFaultAt) {
        lastFaultAt = info.at;
        push("err", fault.textContent);
      }
    } else {
      fault.hidden = true;
    }
  }

  if (data.lastKickKind === "captcha" || (data.lastKickLinks && data.lastKickLinks.length)) {
    showCaptchaBanner(
      data.lastKick || "Captcha / anti-bot kick",
      data.lastKickLinks || [],
      data.lastKickKind || "captcha",
      data.lastVerificationCode || "",
    );
  } else if (data.phase === "in_game") {
    hideCaptchaBanner();
  }

  renderJobs(data);
  renderAlerts(data);
  renderOpsStrip(data);
  updateProfileSelectorUI();

  if (data.position && isView3dPrefEnabled() && isBotLiveForView()) {
    window.fractalSurvey?.setBot(data.position, data.yaw, data.username, data.pitch);
  }
  applyView3dState();
}

function showCaptchaBanner(reason, links = [], kind = "captcha", verificationCode = "") {
  const banner = document.getElementById("captcha-banner");
  const reasonEl = document.getElementById("captcha-reason");
  const codeEl = document.getElementById("captcha-code");
  const linksEl = document.getElementById("captcha-links");
  if (!banner || !reasonEl || !linksEl) return;

  const key = `${kind}|${reason}|${(links || []).join("|")}|${verificationCode || ""}`;
  lastCaptchaKey = key;

  reasonEl.textContent = reason || "Anti-bot / captcha kick (no detail).";
  if (codeEl) {
    if (verificationCode) {
      codeEl.hidden = false;
      codeEl.textContent = `Verification code: ${verificationCode}`;
    } else {
      codeEl.hidden = true;
      codeEl.textContent = "";
    }
  }
  linksEl.replaceChildren();

  const list = Array.isArray(links) ? links.filter(Boolean) : [];
  if (list.length) {
    for (const url of list) {
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = url;
      linksEl.append(a);
    }
  } else {
    const p = document.createElement("p");
    p.className = "captcha-none";
    p.textContent =
      "No URL was found in the kick message. Log into this account with a normal Minecraft client to complete verification.";
    linksEl.append(p);
  }

  banner.hidden = false;
  notifyCaptcha(reason, list, verificationCode);
}

function hideCaptchaBanner() {
  const banner = document.getElementById("captcha-banner");
  if (banner) banner.hidden = true;
  lastCaptchaKey = "";
}

/** Locks so status/fleet refresh cannot flip Connection switches after a manual change. */
const connectionManualUntil = { reconnect: 0, lobby: 0, notify: 0 };

function lockConnectionSwitch(key, ms = 120_000) {
  connectionManualUntil[key] = Date.now() + ms;
}

function connectionSwitchLocked(key) {
  return Date.now() < (connectionManualUntil[key] || 0);
}

function notifyPrefEnabled() {
  // Default ON when unset; only explicit "0" disables
  return localStorage.getItem("fractal-notify") !== "0";
}

function setNotifyPref(on) {
  localStorage.setItem("fractal-notify", on ? "1" : "0");
  syncNotifyToggleUi(true);
}

function notificationPermission() {
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission;
}

/** Keep captcha-notify control in sync with local preference (settings select + legacy toggle). */
function syncNotifyToggleUi(force = false) {
  const perm = notificationPermission();
  const want = notifyPrefEnabled() && perm !== "denied" && perm !== "unsupported";
  const btn = document.getElementById("toggle-notify");
  if (btn) {
    if (!force && (btn.dataset.userTouched === "1" || connectionSwitchLocked("notify"))) {
      /* keep user interaction */
    } else {
      btn.checked = want;
      btn.closest(".task-toggle")?.classList.toggle("on", want);
      btn.closest(".task-toggle")?.classList.toggle("warn", perm === "denied");
    }
  }
  const form = document.getElementById("profile-settings-form");
  if (form?.captchaNotify) {
    form.captchaNotify.value = want ? "true" : "false";
  }
}

/** @deprecated name kept for older call sites */
function updateNotifyChip() {
  syncNotifyToggleUi(true);
}

async function ensureNotificationPermission() {
  if (!("Notification" in window)) {
    push("err", "This browser does not support notifications");
    return false;
  }
  if (Notification.permission === "granted") {
    setNotifyPref(true);
    return true;
  }
  if (Notification.permission === "denied") {
    push("err", "Notifications are blocked — enable them in browser / site settings");
    updateNotifyChip();
    return false;
  }
  try {
    const result = await Notification.requestPermission();
    updateNotifyChip();
    if (result === "granted") {
      setNotifyPref(true);
      push("sys", "Notifications enabled — captcha kicks will alert this device");
      return true;
    }
    push("err", "Notification permission was not granted");
    return false;
  } catch (err) {
    push("err", `Could not request notifications: ${err?.message || err}`);
    return false;
  }
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    swRegistration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    return swRegistration;
  } catch (err) {
    console.warn("service worker register failed", err);
    return null;
  }
}

function notifyCaptcha(reason, links = [], verificationCode = "") {
  if (!notifyPrefEnabled()) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const key = `${reason}|${(links || []).join("|")}|${verificationCode || ""}`;
  if (key && key === lastNotifiedCaptchaKey) return;
  lastNotifiedCaptchaKey = key;

  const link = Array.isArray(links) && links.length ? links[0] : null;
  const title = "6b6t captcha — action needed";
  const codeLine = verificationCode ? `Code: ${verificationCode}\n` : "";
  const body = link
    ? `${codeLine}${String(reason || "Solve captcha").slice(0, 100)}\n${link}`
    : `${codeLine}${String(reason || "Solve the captcha with a normal client, then rejoin.").slice(0, 160)}`;

  // Prefer service worker notification (works better when tab is backgrounded / on mobile)
  if (swRegistration?.active) {
    swRegistration.active.postMessage({
      type: "captcha-notify",
      title,
      body,
      link,
    });
    return;
  }
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: "captcha-notify",
      title,
      body,
      link,
    });
    return;
  }

  try {
    const n = new Notification(title, {
      body,
      tag: "fractal-captcha",
      renotify: true,
      requireInteraction: true,
    });
    n.onclick = () => {
      window.focus();
      if (link) window.open(link, "_blank", "noopener,noreferrer");
      n.close();
    };
  } catch (err) {
    console.warn("notification failed", err);
  }
}

/* —— Wire chat tabs (Tibia / Chat-Tabs style) —— */
const WIRE_MAIN = "main";
const WIRE_MAX_PER_TAB = 300;
const WHISPER_CMD = "w";
const WHISPER_ALIASES = new Set(["w", "msg", "tell", "whisper", "message"]);

/** Wire chat is per profile — switching profiles swaps the whole log/tabs. */
const wireByProfile = new Map();

function emptyWireState() {
  return {
    active: WIRE_MAIN,
    order: [WIRE_MAIN],
    tabs: new Map([
      [WIRE_MAIN, { key: WIRE_MAIN, name: "Main", unread: 0, messages: [] }],
    ]),
  };
}

function currentWire() {
  const id = selectedBotId || "_none";
  if (!wireByProfile.has(id)) wireByProfile.set(id, emptyWireState());
  return wireByProfile.get(id);
}

/** Compatibility accessor: always the selected profile's wire state. */
const wireChat = {
  get active() {
    return currentWire().active;
  },
  set active(v) {
    currentWire().active = v;
  },
  get order() {
    return currentWire().order;
  },
  set order(v) {
    currentWire().order = v;
  },
  get tabs() {
    return currentWire().tabs;
  },
};

const PLAYER_NAME_RE = "[A-Za-z0-9_.\\-]{2,32}";
const TS_PREFIX = "^(?:\\[[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\\]\\s*|<(?:[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)>\\s*)?";
const HEAD_PREFIX = "(?:\\[[^\\]]{1,48}\\]\\s*)?";
const ICON_PREFIX = "(?:[\\u00A0\\s]*(?:[<\\[][^>\\]]{0,32}[>\\]])\\s*)?";

const INCOMING_WHISPER_PATTERNS = (() => {
  const formats = [
    "{player} whispers: {message}",
    "{player} whispers to you: {message}",
    "[{player} -> You]: {message}",
    "{player} -> you: {message}",
    "[PM] {player}: {message}",
    "[MSG] {player}: {message}",
    "[WHISPER] {player}: {message}",
  ];
  const escapeLit = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return formats.map((fmt) => {
    let pattern = "";
    let i = 0;
    while (i < fmt.length) {
      if (fmt.startsWith("{player}", i)) {
        pattern += `(${PLAYER_NAME_RE})`;
        i += "{player}".length;
      } else if (fmt.startsWith("{message}", i)) {
        pattern += "(.*)";
        i += "{message}".length;
      } else {
        pattern += escapeLit(fmt[i]);
        i += 1;
      }
    }
    return new RegExp(TS_PREFIX + HEAD_PREFIX + ICON_PREFIX + pattern + "$", "i");
  });
})();

const OUTGOING_WHISPER_RE = new RegExp(
  TS_PREFIX +
    HEAD_PREFIX +
    ICON_PREFIX +
    "(?:You|you)\\s+whispers?(?:ed)?\\s+to\\s+" +
    ICON_PREFIX +
    `(${PLAYER_NAME_RE})\\s*:?[ \\u00a0]*(.*)$`,
  "i",
);


/** 6b6t-style incoming TPA request */
const TPA_REQUEST_RE = new RegExp(
  TS_PREFIX +
    HEAD_PREFIX +
    ICON_PREFIX +
    `(${PLAYER_NAME_RE})\\s+wants\\s+to\\s+teleport\\s+to\\s+you\\.?\\s*$`,
  "i",
);
const TPA_HINT_RE = new RegExp(
  TS_PREFIX +
    HEAD_PREFIX +
    ICON_PREFIX +
    `Type\\s+/tpy\\s+(${PLAYER_NAME_RE})\\s+to\\s+accept\\s+or\\s+/tpn\\s+\\1\\s+to\\s+deny\\.?\\s*$`,
  "i",
);
const TPA_HINT_LOOSE_RE = new RegExp(
  TS_PREFIX +
    `Type\\s+/tpy\\s+(${PLAYER_NAME_RE})\\s+to\\s+accept.*?/tpn\\s+(${PLAYER_NAME_RE})\\s+to\\s+deny`,
  "i",
);

function classifyWireMessage(raw) {
  const text = String(raw || "").trim();
  if (!text) return { type: "system", text };
  const out = text.match(OUTGOING_WHISPER_RE);
  if (out) {
    return {
      type: "whisper_out",
      player: out[1],
      body: (out[2] || "").trim(),
      text,
      key: out[1].toLowerCase(),
    };
  }
  for (const re of INCOMING_WHISPER_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const player = m[1];
      if (!player || /^(you|me)$/i.test(player)) continue;
      return {
        type: "whisper_in",
        player,
        body: (m[2] || "").trim(),
        text,
        key: player.toLowerCase(),
      };
    }
  }
  const tpa = text.match(TPA_REQUEST_RE);
  if (tpa?.[1] && !/^(you|me)$/i.test(tpa[1])) {
    return { type: "tpa", player: tpa[1], text, key: tpa[1].toLowerCase() };
  }
  const hint = text.match(TPA_HINT_RE) || text.match(TPA_HINT_LOOSE_RE);
  if (hint?.[1] && !/^(you|me)$/i.test(hint[1])) {
    return { type: "tpa_hint", player: hint[1], text, key: hint[1].toLowerCase() };
  }
  return { type: "public", text };
}

function ensureWireTab(key, name) {
  if (wireChat.tabs.has(key)) {
    const t = wireChat.tabs.get(key);
    if (name && t.name !== name) t.name = name;
    return t;
  }
  const tab = { key, name: name || key, unread: 0, messages: [] };
  wireChat.tabs.set(key, tab);
  if (!wireChat.order.includes(key)) wireChat.order.push(key);
  return tab;
}

function wireDisplayText(entry) {
  if (entry.kind === "whisper-in" && entry.player) {
    return `${entry.player} whispers: ${entry.body || entry.text}`;
  }
  if (entry.kind === "whisper-out" && entry.player) {
    return `You whisper to ${entry.player}: ${entry.body || entry.text}`;
  }
  return entry.text;
}

function appendEntryToLog(el, entry) {
  const li = document.createElement("li");
  li.className = entry.kind || "";
  const time = document.createElement("time");
  time.textContent = entry.at || fmtLocalTime();
  li.append(time, document.createTextNode(wireDisplayText(entry)));
  if (Array.isArray(entry.links) && entry.links.length) {
    for (const url of entry.links) {
      li.append(document.createTextNode(" "));
      const a = document.createElement("a");
      a.className = "captcha-inline";
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = url;
      li.append(a);
    }
  }
  el.append(li);
}

let pendingTpaPlayer = null;

function showTpaBanner(player) {
  pendingTpaPlayer = player;
  const banner = document.getElementById("tpa-banner");
  if (!banner) return;
  banner.hidden = false;
  const nameEl = banner.querySelector(".tpa-player");
  if (nameEl) nameEl.textContent = player;
}

function hideTpaBanner() {
  pendingTpaPlayer = null;
  const banner = document.getElementById("tpa-banner");
  if (banner) banner.hidden = true;
}

async function respondTpa(entryOrPlayer, action) {
  const player =
    typeof entryOrPlayer === "string"
      ? entryOrPlayer
      : entryOrPlayer?.player || pendingTpaPlayer;
  if (!player) return;
  const cmd = action === "accept" ? `tpy ${player}` : `tpn ${player}`;
  try {
    await rpc("command", { command: cmd });
    push("sys", `/${cmd}`);
    for (const tab of wireChat.tabs.values()) {
      for (const m of tab.messages) {
        if (m.kind === "tpa" && m.playerKey === String(player).toLowerCase() && m.tpaPending) {
          m.tpaPending = false;
          m.tpaResolved = action;
        }
      }
    }
    if (pendingTpaPlayer && pendingTpaPlayer.toLowerCase() === String(player).toLowerCase()) {
      hideTpaBanner();
    }
    renderActiveWireLog();
  } catch (err) {
    push("err", `TPA ${action} failed: ${err instanceof Error ? err.message : err}`);
  }
}

function bindTpaBanner(id) {
  const banner = document.getElementById(id);
  if (!banner || banner.dataset.bound) return;
  banner.dataset.bound = "1";
  banner.querySelector(".tpa-accept")?.addEventListener("click", () => {
    void respondTpa(pendingTpaPlayer, "accept");
  });
  banner.querySelector(".tpa-deny")?.addEventListener("click", () => {
    void respondTpa(pendingTpaPlayer, "deny");
  });
  banner.querySelector(".tpa-dismiss")?.addEventListener("click", () => hideTpaBanner());
}
bindTpaBanner("tpa-banner");


const WIRE_STICK_PX = 56;

function isWireLogPinned(el) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= WIRE_STICK_PX;
}

function updateWireJumpButton(el) {
  const wrap = el?.closest?.(".wire-log-wrap");
  const btn = wrap?.querySelector?.(".wire-jump-bottom");
  if (!btn) return;
  const show = el.scrollHeight > el.clientHeight + 8 && !isWireLogPinned(el);
  btn.hidden = !show;
}

function scrollWireLogToBottom(el) {
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  updateWireJumpButton(el);
}

function renderActiveWireLog() {
  const tab = wireChat.tabs.get(wireChat.active) || wireChat.tabs.get(WIRE_MAIN);
  const logs = document.querySelectorAll(".wire-log");
  for (const el of logs) {
    const pinned = isWireLogPinned(el);
    el.replaceChildren();
    if (!tab) {
      updateWireJumpButton(el);
      continue;
    }
    for (const entry of tab.messages) appendEntryToLog(el, entry);
    if (pinned) scrollWireLogToBottom(el);
    else updateWireJumpButton(el);
  }
}

function bindWireLogScrollBehavior() {
  for (const el of document.querySelectorAll(".wire-log")) {
    if (el.dataset.scrollBound) continue;
    el.dataset.scrollBound = "1";
    el.addEventListener(
      "scroll",
      () => {
        updateWireJumpButton(el);
      },
      { passive: true },
    );
  }
  for (const btn of document.querySelectorAll(".wire-jump-bottom")) {
    if (btn.dataset.bound) continue;
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => {
      const wrap = btn.closest(".wire-log-wrap");
      const log = wrap?.querySelector?.(".wire-log");
      scrollWireLogToBottom(log);
    });
  }
}
bindWireLogScrollBehavior();

function renderWireTabs() {
  const bars = [document.getElementById("wire-tabs")].filter(Boolean);
  for (const bar of bars) {
    bar.replaceChildren();
    for (const key of wireChat.order) {
      const tab = wireChat.tabs.get(key);
      if (!tab) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "wire-tab";
      if (key === wireChat.active) btn.classList.add("on");
      if (tab.unread > 0 && key !== wireChat.active) btn.classList.add("has-unread");
      btn.dataset.wireTab = key;
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", key === wireChat.active ? "true" : "false");

      const label = document.createElement("span");
      label.textContent = tab.name;
      btn.append(label);

      if (tab.unread > 0 && key !== wireChat.active) {
        const badge = document.createElement("span");
        badge.className = "wire-unread";
        badge.textContent = tab.unread > 99 ? "99+" : String(tab.unread);
        btn.append(badge);
      }

      if (key !== WIRE_MAIN) {
        const close = document.createElement("span");
        close.className = "wire-close";
        close.textContent = "×";
        close.title = "Close tab";
        close.addEventListener("click", (e) => {
          e.stopPropagation();
          closeWireTab(key);
        });
        btn.append(close);
      }

      btn.addEventListener("click", () => selectWireTab(key));
      bar.append(btn);
    }
  }
  updateWirePlaceholder();
}

function selectWireTab(key) {
  if (!wireChat.tabs.has(key)) key = WIRE_MAIN;
  wireChat.active = key;
  const tab = wireChat.tabs.get(key);
  if (tab) tab.unread = 0;
  renderWireTabs();
  renderActiveWireLog();
}

function closeWireTab(key) {
  if (key === WIRE_MAIN) return;
  wireChat.tabs.delete(key);
  wireChat.order = wireChat.order.filter((k) => k !== key);
  if (wireChat.active === key) {
    wireChat.active = wireChat.order[wireChat.order.length - 1] || WIRE_MAIN;
    const active = wireChat.tabs.get(wireChat.active);
    if (active) active.unread = 0;
  }
  renderWireTabs();
  renderActiveWireLog();
}

function updateWirePlaceholder() {
  const active = wireChat.tabs.get(wireChat.active);
  const isPrivate = wireChat.active !== WIRE_MAIN && active;
  const ph = isPrivate
    ? `Reply to ${active.name} (or /command)`
    : "say in chat, or /command";
  for (const id of ["say-input"]) {
    const input = document.getElementById(id);
    if (input) input.placeholder = ph;
  }
}

function wireStateFor(botId) {
  const id = botId || selectedBotId || "_none";
  if (!wireByProfile.has(id)) wireByProfile.set(id, emptyWireState());
  return wireByProfile.get(id);
}

function ensureWireTabIn(state, key, name) {
  if (state.tabs.has(key)) {
    const tab = state.tabs.get(key);
    if (name && tab.name !== name) tab.name = name;
    return tab;
  }
  const tab = { key, name: name || key, unread: 0, messages: [] };
  state.tabs.set(key, tab);
  if (!state.order.includes(key)) state.order.push(key);
  return tab;
}

function pushWireEntry(entry, botId) {
  const targetId = botId || selectedBotId || "_none";
  const state = wireStateFor(targetId);
  const main = ensureWireTabIn(state, WIRE_MAIN, "Main");
  main.messages.push(entry);
  if (main.messages.length > WIRE_MAX_PER_TAB) main.messages.splice(0, main.messages.length - WIRE_MAX_PER_TAB);

  if (entry.playerKey && entry.playerKey !== WIRE_MAIN) {
    const priv = ensureWireTabIn(state, entry.playerKey, entry.player || entry.playerKey);
    priv.messages.push(entry);
    if (priv.messages.length > WIRE_MAX_PER_TAB) priv.messages.splice(0, priv.messages.length - WIRE_MAX_PER_TAB);
    if (state.active !== priv.key) priv.unread += 1;
  }

  // Only redraw if this is the profile currently on screen
  if (targetId === (selectedBotId || "_none")) {
    renderWireTabs();
    renderActiveWireLog();
  }
}

function push(kind, text, links, botId) {
  const raw = text == null ? "" : String(text);
  let entry = {
    kind: kind || "",
    text: raw,
    links: Array.isArray(links) ? links : undefined,
    at: fmtLocalTime(),
  };

  if (!kind || kind === "") {
    const c = classifyWireMessage(raw);
    if (c.type === "whisper_in") {
      entry = {
        kind: "whisper-in",
        text: raw,
        body: c.body,
        player: c.player,
        playerKey: c.key,
        at: entry.at,
      };
    } else if (c.type === "whisper_out") {
      // Already shown from the /w command we sent — skip server echo
      if (isDuplicateOutgoingWhisper(c.player, c.body)) {
        return;
      }
      entry = {
        kind: "whisper-out",
        text: raw,
        body: c.body,
        player: c.player,
        playerKey: c.key,
        at: entry.at,
      };
    } else if (c.type === "tpa" || c.type === "tpa_hint") {
      entry = {
        kind: "tpa",
        text: raw,
        player: c.player,
        playerKey: c.key,
        at: entry.at,
        tpaPending: true,
      };
      // Banner only when this profile is selected
      if (!botId || botId === selectedBotId) showTpaBanner(c.player);
    }
  }

  pushWireEntry(entry, botId);
}

/** Recent locally-sent whispers (suppress server-echo duplicates). */
const recentOutgoingWhispers = [];
const OUTGOING_WHISPER_DEDUP_MS = 8000;

function rememberOutgoingWhisper(player, body) {
  const key = `${String(player).toLowerCase()}\0${String(body || "").trim()}`;
  recentOutgoingWhispers.push({ key, at: Date.now() });
  while (recentOutgoingWhispers.length > 40) recentOutgoingWhispers.shift();
}

function isDuplicateOutgoingWhisper(player, body) {
  const key = `${String(player).toLowerCase()}\0${String(body || "").trim()}`;
  const now = Date.now();
  while (recentOutgoingWhispers.length && now - recentOutgoingWhispers[0].at > OUTGOING_WHISPER_DEDUP_MS) {
    recentOutgoingWhispers.shift();
  }
  const idx = recentOutgoingWhispers.findIndex((x) => x.key === key);
  if (idx < 0) return false;
  recentOutgoingWhispers.splice(idx, 1);
  return true;
}

/** Parse `/w name body` style outbound so we open/bump the private tab immediately. */
function noteOutgoingWhisperCommand(commandText) {
  const c = String(commandText || "").trim().replace(/^\//, "");
  const parts = c.split(/\s+/);
  if (parts.length < 3) return;
  const base = parts[0].toLowerCase();
  if (!WHISPER_ALIASES.has(base)) return;
  const player = parts[1];
  const body = parts.slice(2).join(" ");
  if (!player || !body) return;
  rememberOutgoingWhisper(player, body);
  pushWireEntry({
    kind: "whisper-out",
    text: `You whisper to ${player}: ${body}`,
    body,
    player,
    playerKey: player.toLowerCase(),
    at: fmtLocalTime(),
    localEcho: true,
  });
}

async function sendWireMessage(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return;
  if (trimmed.startsWith("/")) {
    const cmd = trimmed.slice(1);
    noteOutgoingWhisperCommand(cmd);
    // Track home names from /sethome and /delhome so suggestions stay fresh offline
    const homeMatch = cmd.match(/^(sethome|delhome)\s+(\S+)/i);
    if (homeMatch) {
      if (homeMatch[1].toLowerCase() === "sethome") rememberHomes([homeMatch[2]]);
      else forgetHomeName(homeMatch[2]);
    }
    // Dedicated path: wait for GUI and seed home list (server tab-complete is broken on 6b6t)
    if (/^homes\b/i.test(cmd)) {
      const res = await rpc("openHomes");
      if (res.ok && res.data) {
        renderInventory(res.data);
        if (Array.isArray(res.data.homes)) replaceHomes(res.data.homes);
        if (res.data.homesDialog?.homes?.length) {
          replaceHomes(res.data.homesDialog.homes);
          showHomesDialogPanel(res.data.homesDialog.title || "Homes", res.data.homesDialog.homes);
          push("sys", `homes dialog (${res.data.homesDialog.homes.length} homes)`);
        } else if (res.data.window?.slots?.length) {
          push("sys", `homes window open (${res.data.window.slots.length} slots)`);
        } else {
          await showHomesFallbackPanel();
          push("sys", "homes: no dialog/GUI yet — showing known homes as buttons");
        }
      } else {
        await rpc("command", { command: cmd });
        setTimeout(() => void refresh({ force: true }), 400);
        setTimeout(() => void showHomesFallbackPanel(), 600);
      }
      return;
    }
    await rpc("command", { command: cmd });
    return;
  }
  const active = wireChat.tabs.get(wireChat.active);
  if (wireChat.active !== WIRE_MAIN && active?.name) {
    const cmd = `${WHISPER_CMD} ${active.name} ${trimmed}`;
    noteOutgoingWhisperCommand(cmd);
    await rpc("command", { command: cmd });
    return;
  }
  await rpc("chat", { message: trimmed });
}

/* —— Slash-command suggestions (Minecraft-style) —— */
const MC_COMMANDS = [
  { cmd: "w", hint: "<player> <msg>", playerArg: true },
  { cmd: "msg", hint: "<player> <msg>", playerArg: true },
  { cmd: "tell", hint: "<player> <msg>", playerArg: true },
  { cmd: "whisper", hint: "<player> <msg>", playerArg: true },
  { cmd: "r", hint: "<msg> reply last whisper" },
  { cmd: "reply", hint: "<msg>" },
  { cmd: "tpa", hint: "<player>", playerArg: true },
  { cmd: "tpahere", hint: "<player>", playerArg: true },
  { cmd: "tpaccept", hint: "accept TPA" },
  { cmd: "tpdeny", hint: "deny TPA" },
  { cmd: "tpcancel", hint: "cancel outgoing TPA" },
  { cmd: "home", hint: "[name]" },
  { cmd: "sethome", hint: "[name]" },
  { cmd: "delhome", hint: "<name>" },
  { cmd: "homes", hint: "list homes" },
  { cmd: "spawn", hint: "go to spawn" },
  { cmd: "kill", hint: "suicide" },
  { cmd: "ignore", hint: "<player>", playerArg: true },
  { cmd: "unignore", hint: "<player>", playerArg: true },
  { cmd: "ignorelist", hint: "list ignored" },
  { cmd: "login", hint: "<password>" },
  { cmd: "register", hint: "<password> <password>" },
  { cmd: "changepassword", hint: "<old> <new>" },
  { cmd: "discord", hint: "link / info" },
  { cmd: "help", hint: "[command]" },
  { cmd: "me", hint: "<action>" },
  { cmd: "msg", hint: "<player> <msg>", playerArg: true },
  { cmd: "pm", hint: "<player> <msg>", playerArg: true },
];

// Dedupe by cmd name (keep first)
const MC_COMMAND_LIST = (() => {
  const seen = new Set();
  const out = [];
  for (const c of MC_COMMANDS) {
    if (seen.has(c.cmd)) continue;
    seen.add(c.cmd);
    out.push(c);
  }
  return out;
})();

const PLAYER_ARG_COMMANDS = new Set(
  MC_COMMAND_LIST.filter((c) => c.playerArg).map((c) => c.cmd),
);

/** Commands whose first argument is a home name (tab-complete from server). */
const HOME_ARG_COMMANDS = new Set(["home", "delhome"]);

/** Home names per profile id — never mixed across accounts. */
const homesByProfile = new Map();

function homesSetFor(botId) {
  const id = botId || selectedBotId || "_none";
  if (!homesByProfile.has(id)) homesByProfile.set(id, new Set());
  return homesByProfile.get(id);
}

function rememberHomes(names, botId) {
  if (!Array.isArray(names)) return;
  const set = homesSetFor(botId);
  for (const n of names) {
    const s = String(n || "").trim();
    if (s && !s.includes(" ")) set.add(s);
  }
}

function forgetHomeName(name, botId) {
  homesSetFor(botId).delete(String(name || "").trim());
}

/** Replace the full list for a profile (e.g. after /homes). */
function replaceHomes(names, botId) {
  const set = homesSetFor(botId);
  set.clear();
  rememberHomes(names, botId);
}

function collectSuggestPlayers(prefix) {
  const selfName = (window.__fractalStatus?.username || "").toLowerCase();
  const names = new Set();
  for (const n of knownPlayerNames) names.add(n);
  for (const key of wireChat.order) {
    if (key === WIRE_MAIN) continue;
    const t = wireChat.tabs.get(key);
    if (t?.name) names.add(t.name);
  }
  const pfx = String(prefix || "").toLowerCase();
  return [...names]
    .filter((n) => n && n.toLowerCase() !== selfName)
    .filter((n) => !pfx || n.toLowerCase().startsWith(pfx))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .slice(0, 12);
}

function collectSuggestHomes(prefix) {
  const pfx = String(prefix || "").toLowerCase();
  return [...homesSetFor(selectedBotId)]
    .filter((n) => !pfx || n.toLowerCase().startsWith(pfx))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .slice(0, 16);
}

function buildCommandSuggestions(value) {
  const text = String(value || "");
  if (!text.startsWith("/")) return [];

  const body = text.slice(1);
  const space = body.indexOf(" ");
  // Still typing the command name
  if (space < 0) {
    const pfx = body.toLowerCase();
    return MC_COMMAND_LIST.filter((c) => !pfx || c.cmd.startsWith(pfx))
      .slice(0, 12)
      .map((c) => ({
        kind: "cmd",
        label: `/${c.cmd}`,
        insert: `/${c.cmd} `,
        hint: c.hint || "",
      }));
  }

  const cmdName = body.slice(0, space).toLowerCase();
  const after = body.slice(space + 1);
  // Player-arg commands: suggest names for the first argument only
  if (PLAYER_ARG_COMMANDS.has(cmdName) && !after.includes(" ")) {
    return collectSuggestPlayers(after).map((name) => ({
      kind: "player",
      label: name,
      insert: `/${cmdName} ${name} `,
      hint: "player",
    }));
  }
  // Home-arg commands: suggest known homes (refreshed async from server tab-complete)
  if (HOME_ARG_COMMANDS.has(cmdName) && !after.includes(" ")) {
    return collectSuggestHomes(after).map((name) => ({
      kind: "home",
      label: name,
      insert: `/${cmdName} ${name}`,
      hint: "home",
    }));
  }
  return [];
}

/** Refresh local home list from bot (chat/GUI learned). No noisy server tab-complete spam. */
let homeTabCompleteTimer = null;
let homeTabCompleteSeq = 0;
async function requestHomeTabComplete(partialCommand) {
  const seq = ++homeTabCompleteSeq;
  try {
    const res = await rpc("tabComplete", { partial: partialCommand.replace(/^\//, "") });
    if (seq !== homeTabCompleteSeq) return;
    if (res?.ok && Array.isArray(res.data)) {
      const names = res.data.map((s) => {
        const t = String(s).trim();
        const parts = t.split(/\s+/);
        return parts[parts.length - 1];
      });
      rememberHomes(names);
    }
  } catch {
    /* offline */
  }
}

function scheduleHomeTabComplete(value) {
  const text = String(value || "");
  if (!text.startsWith("/")) return;
  const m = text.match(/^\/(home|delhome)(\s(.*))?$/i);
  if (!m) return;
  clearTimeout(homeTabCompleteTimer);
  homeTabCompleteTimer = setTimeout(() => {
    const arg = m[3] != null ? m[3] : "";
    void requestHomeTabComplete(`${m[1].toLowerCase()} ${arg}`);
  }, 120);
}

async function seedHomesForSelectedProfile() {
  if (!selectedBotId) return;
  try {
    const res = await rpc("homes");
    if (res?.ok && Array.isArray(res.data)) {
      // Server list is authoritative for this profile
      replaceHomes(res.data, selectedBotId);
    }
  } catch {
    /* not connected yet */
  }
}

// Seed homes for the selected profile when the page loads
void seedHomesForSelectedProfile();

function bindSaySuggestions(inputId, listId) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  if (!input || !list) return;

  let items = [];
  let active = -1;

  const hide = () => {
    list.hidden = true;
    list.replaceChildren();
    items = [];
    active = -1;
  };

  const render = () => {
    list.replaceChildren();
    if (!items.length) {
      list.hidden = true;
      return;
    }
    list.hidden = false;
    items.forEach((it, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      if (i === active) li.classList.add("on");
      const cmd = document.createElement("span");
      cmd.className = "sg-cmd";
      cmd.textContent = it.label;
      li.append(cmd);
      if (it.hint) {
        const hint = document.createElement("span");
        hint.className = "sg-hint";
        hint.textContent = it.hint;
        li.append(hint);
      }
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        apply(i);
      });
      list.append(li);
    });
  };

  const refresh = () => {
    scheduleHomeTabComplete(input.value);
    items = buildCommandSuggestions(input.value);
    active = items.length ? 0 : -1;
    render();
  };

  const apply = (index) => {
    const it = items[index];
    if (!it) return;
    input.value = it.insert;
    input.focus();
    const pos = input.value.length;
    input.setSelectionRange(pos, pos);
    refresh();
  };

  input.addEventListener("input", () => {
    refresh();
    // After server tab-complete returns, rebuild list if still focused
    if (/^\/(home|delhome)\b/i.test(input.value)) {
      setTimeout(() => {
        if (document.activeElement === input) {
          items = buildCommandSuggestions(input.value);
          active = items.length ? 0 : -1;
          render();
        }
      }, 280);
    }
  });
  input.addEventListener("focus", refresh);
  input.addEventListener("blur", () => {
    // Delay so mousedown on a suggestion can fire
    setTimeout(hide, 120);
  });

  input.addEventListener("keydown", (e) => {
    if (list.hidden || !items.length) {
      if (e.key === "Tab" && input.value.startsWith("/")) {
        // Force a refresh and try complete
        items = buildCommandSuggestions(input.value);
        if (items.length) {
          e.preventDefault();
          apply(0);
        }
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      active = (active + 1) % items.length;
      render();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      active = (active - 1 + items.length) % items.length;
      render();
      return;
    }
    if (e.key === "Tab" || (e.key === "Enter" && e.shiftKey === false && items.length && active >= 0 && e.target.value.match(/^\/\S*$/))) {
      // Tab always completes; Enter only completes when still on bare command name
      if (e.key === "Tab" || /^\/\S*$/.test(input.value)) {
        e.preventDefault();
        apply(active >= 0 ? active : 0);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      hide();
    }
  });
}

bindSaySuggestions("say-input", "say-suggest");

// Initial tab bar
renderWireTabs();
renderActiveWireLog();

function eventBotId(data) {
  if (data && typeof data === "object" && data.botId) return String(data.botId);
  return "";
}

function isActiveBotEvent(data) {
  if (!selectedBotId) return true;
  const id = eventBotId(data);
  if (!id) return true; // legacy untagged events
  return id === selectedBotId;
}

let lastSeenChat = "";

/** Usernames seen on tab list / nearby — used for /w and /tpa suggestions. */
const knownPlayerNames = new Set();

function rememberPlayers(players) {
  const selfName = (window.__fractalStatus?.username || "").toLowerCase();
  for (const p of players || []) {
    const n = String(p?.username || "").trim();
    if (!n) continue;
    if (n.toLowerCase() === selfName) continue;
    knownPlayerNames.add(n);
  }
  // Cap memory
  if (knownPlayerNames.size > 400) {
    const keep = [...knownPlayerNames].slice(-300);
    knownPlayerNames.clear();
    for (const n of keep) knownPlayerNames.add(n);
  }
}

function renderPlayers(players) {
  const ul = document.getElementById("players");
  ul.innerHTML = "";
  rememberPlayers(players);
  // Nearby = loaded entities only (have distance). Tab-list ghosts with no
  // pose are excluded so the panel does not fill with the whole server.
  const selfName = (window.__fractalStatus?.username || "").toLowerCase();
  const rows = (players || [])
    .filter((p) => p && p.distance != null && Number.isFinite(p.distance))
    .filter((p) => String(p.username || "").toLowerCase() !== selfName)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 40);
  document.getElementById("player-count").textContent = rows.length ? `(${rows.length})` : "";
  for (const p of rows) {
    const li = document.createElement("li");
    li.className = "player-row";
    const name = String(p.username ?? "");
    if (p.skinUrl) rememberSkinUrl(name, p.skinUrl);
    const av = playerAvatarEl(name, p.skinUrl, 24);
    const nameEl = document.createElement("span");
    nameEl.className = "player-name";
    nameEl.textContent = name;
    const distEl = document.createElement("span");
    distEl.className = "player-dist";
    distEl.textContent = `${Number(p.distance).toFixed(1)}m`;
    li.append(av, nameEl, distEl);
    ul.append(li);
  }
  if (!rows.length) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = "nobody in range";
    li.append(span);
    ul.append(li);
  }
}

let selectedSlot = null;
let packView = { quickBarSlot: 0, held: null, slots: [] };
const SLOT_LABELS = { 5: "helmet", 6: "chestplate", 7: "leggings", 8: "boots", 45: "offhand" };
const ARMOR_SLOT_KIND = { 5: "head", 6: "chest", 7: "legs", 8: "feet", 45: "offhand" };
const ARMOR_SLOTS = new Set([5, 6, 7, 8]);

function asInvView(data) {
  if (Array.isArray(data)) return { quickBarSlot: 0, held: null, slots: data };
  return data || { quickBarSlot: 0, held: null, slots: [] };
}

function slotMap(slots) {
  const map = new Map();
  for (const item of slots || []) map.set(item.slot, item);
  return map;
}

function cleanItemName(name) {
  return String(name || "")
    .trim()
    .replace(/^minecraft:/i, "")
    .toLowerCase();
}

/** Matching armor slot for an item, or null if unrestricted. */
function equipmentSlotForItem(name) {
  const n = cleanItemName(name);
  if (!n) return null;
  if (/(_helmet|turtle_helmet)$/.test(n) || n === "carved_pumpkin" || /(_head|_skull)$/.test(n)) return 5;
  if (/(_chestplate|elytra)$/.test(n)) return 6;
  if (/_leggings$/.test(n)) return 7;
  if (/_boots$/.test(n)) return 8;
  return null;
}

function isArmorOnlyItem(name) {
  return equipmentSlotForItem(name) != null;
}

/**
 * Vanilla-style rule: armor slots 5–8 only accept the matching piece.
 * Off-hand and main inventory accept anything (armor pieces included).
 */
function itemFitsSlot(name, slot) {
  if (!ARMOR_SLOTS.has(slot)) return true;
  if (!name) return true;
  return equipmentSlotForItem(name) === slot;
}

function canSwapSlots(fromSlot, toSlot, bySlot) {
  const fromItem = bySlot.get(fromSlot);
  const toItem = bySlot.get(toSlot);
  if (fromItem && !itemFitsSlot(fromItem.name, toSlot)) {
    return {
      ok: false,
      reason: `${itemLabel(fromItem) || cleanItemName(fromItem.name)} cannot go in the ${SLOT_LABELS[toSlot] || `slot ${toSlot}`} slot`,
    };
  }
  if (toItem && !itemFitsSlot(toItem.name, fromSlot)) {
    return {
      ok: false,
      reason: `${itemLabel(toItem) || cleanItemName(toItem.name)} cannot go in the ${SLOT_LABELS[fromSlot] || `slot ${fromSlot}`} slot`,
    };
  }
  return { ok: true };
}

function itemLabel(item) {
  if (!item) return "";
  for (const key of ["displayName", "customName", "name"]) {
    let v = item[key];
    if (v && typeof v === "object") {
      v = v.text || v.value || v.toMotd?.() || v.getText?.() || "";
    }
    v = String(v || "").trim();
    if (v && v !== "[object Object]") return v;
  }
  return "item";
}

function shortTag(name) {
  // Guard against ChatMessage / object values that used to render as "[OBJE"
  let raw = name;
  if (raw && typeof raw === "object") {
    raw = raw.text || raw.value || raw.toMotd?.() || raw.getText?.() || "";
  }
  raw = String(raw || "").trim();
  if (!raw || raw === "[object Object]") return "?";
  const parts = raw.replace(/^minecraft:/, "").split("_").filter(Boolean);
  if (!parts.length) return raw.slice(0, 5);
  if (parts.length === 1) return parts[0].slice(0, 5);
  return parts.map((p) => p.slice(0, 3)).join("").slice(0, 6);
}

function itemTint(name) {
  let h = 2166136261;
  const s = String(name || "");
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  const t = (h >>> 0) / 4294967296;
  return `hsl(${16 + t * 38} ${38 + t * 18}% ${16 + t * 14}%)`;
}


/** Minecraft texture CDNs (try several — phones / CDNs fail intermittently). */
const MC_ASSET_VER = "1.21.1";
const MC_ICON_BASES = [
  `https://assets.mcasset.cloudflare.com/${MC_ASSET_VER}/assets/minecraft/textures`,
  `https://cdn.jsdelivr.net/gh/InventivetalentDev/minecraft-assets@${MC_ASSET_VER}/assets/minecraft/textures`,
  `https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/${MC_ASSET_VER}/assets/minecraft/textures`,
];
/**
 * Registry names with no dedicated PNG (vanilla model points at another texture).
 * Keep in sync with server ITEM_TEXTURE_ALIASES — proxy also resolves via model JSON
 * and `_side`/`_front` fallbacks for block items.
 */
const ITEM_TEXTURE_ALIASES = {
  enchanted_golden_apple: "golden_apple",
  crossbow: "crossbow_standby",
  clock: "clock_00",
  compass: "compass_16",
  recovery_compass: "recovery_compass_16",
  debug_stick: "stick",
  tipped_arrow: "tipped_arrow_base",
  large_fern: "large_fern_top",
  chest: "oak_planks",
  trapped_chest: "oak_planks",
  ender_chest: "obsidian",
  shield: "dark_oak_planks",
  infested_stone: "stone",
  infested_cobblestone: "cobblestone",
  infested_stone_bricks: "stone_bricks",
  infested_mossy_stone_bricks: "mossy_stone_bricks",
  infested_cracked_stone_bricks: "cracked_stone_bricks",
  infested_chiseled_stone_bricks: "chiseled_stone_bricks",
  infested_deepslate: "deepslate",
};
/** id → resolved absolute URL once we find one that loads */
const itemIconResolved = new Map();

function itemTextureId(name) {
  let raw = name;
  if (raw && typeof raw === "object") {
    raw = raw.text || raw.value || "";
  }
  raw = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, "");
  if (!raw || raw === "air" || raw === "empty" || raw === "unknown") return "";
  const id = raw.replace(/[^a-z0-9_/.-]/g, "");
  if (id.endsWith("_spawn_egg")) return "spawn_egg";
  return ITEM_TEXTURE_ALIASES[id] || id;
}

function itemIconUrls(name) {
  const id = itemTextureId(name);
  if (!id) return [];
  if (itemIconResolved.has(id)) return [itemIconResolved.get(id)];
  // Same-origin proxy (CSP img-src 'self' only — external CDNs are blocked).
  // Server also resolves model layer0 aliases for items we haven't hard-coded.
  return [`/asset/item/${encodeURIComponent(id)}.png`];
}

function setItemIcon(img, name) {
  if (!img) return;
  const id = itemTextureId(name);
  const urls = itemIconUrls(name);
  const cell = img.parentElement;
  if (!urls.length) {
    img.removeAttribute("src");
    img.hidden = true;
    img.dataset.iconId = "";
    cell?.classList.add("no-icon");
    return;
  }
  // Already showing this item successfully
  if (img.dataset.iconId === id && img.complete && img.naturalWidth > 0 && !img.hidden) {
    cell?.classList.remove("no-icon");
    return;
  }
  // Keep text visible until a texture loads
  cell?.classList.add("no-icon");
  img.dataset.iconId = id;
  img.dataset.iconTry = "0";
  img.hidden = false;
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.onerror = () => {
    const i = Number(img.dataset.iconTry || "0") + 1;
    img.dataset.iconTry = String(i);
    if (i < urls.length) {
      img.src = urls[i];
    } else {
      img.hidden = true;
      img.removeAttribute("src");
      cell?.classList.add("no-icon");
    }
  };
  img.onload = () => {
    if (img.naturalWidth > 0) {
      img.hidden = false;
      cell?.classList.remove("no-icon");
      if (id) itemIconResolved.set(id, img.currentSrc || img.src);
    }
  };
  img.src = urls[0];
}

/** username(lower) → last known skin URL (from bot / nearby / status) */
const skinUrlCache = new Map();

function rememberSkinUrl(username, url) {
  if (!username || !url) return;
  skinUrlCache.set(String(username).toLowerCase(), String(url));
}

function activeBotUsername() {
  const fromStatus = status?.username || status?.name;
  if (fromStatus) return String(fromStatus);
  const bot = (fleetState?.bots || []).find((b) => b.id === selectedBotId);
  return bot?.username ? String(bot.username) : "";
}

/** Tiny Steve silhouette when every skin CDN fails (offline / cracked). */
const STEVE_PLACEHOLDER =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="80" viewBox="0 0 40 80">` +
      `<rect width="40" height="80" fill="#2a2a2a"/>` +
      `<rect x="12" y="4" width="16" height="16" fill="#c6a57b"/>` +
      `<rect x="10" y="20" width="20" height="24" fill="#3d6ea5"/>` +
      `<rect x="4" y="20" width="6" height="24" fill="#3d6ea5"/>` +
      `<rect x="30" y="20" width="6" height="24" fill="#3d6ea5"/>` +
      `<rect x="12" y="44" width="7" height="28" fill="#3a4570"/>` +
      `<rect x="21" y="44" width="7" height="28" fill="#3a4570"/>` +
      `</svg>`,
  );

/**
 * Prefer rendered skins via local proxy (CSP blocks external img hosts).
 * kind=avatar → face (nearby list); kind=body → full figure (inventory panel).
 * Never use the raw 64×64 sheet as an <img> — the proxy crops/renders it.
 */
function resolveSkinUrls(username, skinUrl, kind = "avatar") {
  const user = String(username || "").trim();
  const direct = skinUrl || (user ? skinUrlCache.get(user.toLowerCase()) : "");
  const urls = [];
  if (user || direct) {
    const q = new URLSearchParams();
    if (user) q.set("u", user);
    if (direct) q.set("url", direct);
    q.set("kind", kind === "body" ? "body" : "avatar");
    urls.push(`/asset/skin?${q.toString()}`);
  }
  urls.push(STEVE_PLACEHOLDER);
  return urls;
}

function applySkinToImage(img, username, skinUrl, kind = "avatar") {
  if (!img) return;
  const urls = resolveSkinUrls(username, skinUrl, kind);
  if (!urls.length) {
    img.hidden = true;
    img.removeAttribute("src");
    return;
  }
  img.hidden = false;
  img.alt = username ? `${username} skin` : "skin";
  img.dataset.skinTry = "0";
  img.dataset.skinKey = `${username || ""}|${kind}|${urls[0]}`;
  img.onerror = () => {
    const i = Number(img.dataset.skinTry || "0") + 1;
    img.dataset.skinTry = String(i);
    if (i < urls.length) img.src = urls[i];
    else {
      img.hidden = true;
      img.removeAttribute("src");
    }
  };
  img.onload = () => {
    img.hidden = false;
  };
  img.src = urls[0];
}

let lastSkinKey = "";
function updateInventorySkin() {
  const img = document.getElementById("inv-skin");
  const label = document.getElementById("inv-skin-name");
  const user = activeBotUsername();
  const serverUrl = status?.skinUrl || skinUrlCache.get(String(user || "").toLowerCase());
  if (label) label.textContent = user || "no skin";
  if (!img) return;
  const key = `${user}|body|${serverUrl || ""}`;
  if (key === lastSkinKey && img.src && !img.hidden) return;
  lastSkinKey = key;
  if (!user && !serverUrl) {
    img.hidden = true;
    img.removeAttribute("src");
    return;
  }
  applySkinToImage(img, user, serverUrl, "body");
}

function playerAvatarEl(username, skinUrl, size = 22) {
  const img = document.createElement("img");
  img.className = "player-avatar";
  img.width = size;
  img.height = size;
  img.alt = "";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  applySkinToImage(img, username, skinUrl, "avatar");
  return img;
}

/**
 * High-contrast SVG silhouettes (data URIs) so empty armor slots always show
 * a clear helmet / chest / legs / boots / shield outline — no CDN dependency.
 */
const ARMOR_PLACEHOLDER_SVG = {
  head: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges"><path fill="#9a9a9a" d="M4 3h8v1h1v4h-1v1H4V8H3V4h1V3zm1 2v3h6V5H5z"/><path fill="#6e6e6e" d="M5 5h6v1H5zm0 2h6v1H5z"/></svg>`,
  chest: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges"><path fill="#9a9a9a" d="M3 2h3v1h4V2h3v1h1v3h-1v7H4V6H3V3h1V2zm1 2v1h1v7h6V5h1V4h-2v1H6V4H4z"/><path fill="#6e6e6e" d="M6 5h4v1H6zm0 2h4v1H6z"/></svg>`,
  legs: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges"><path fill="#9a9a9a" d="M4 2h8v1h1v5h-1v6H9v-6H7v6H4V8H3V3h1V2zm1 2v4h2V4H5zm4 0v4h2V4H9z"/><path fill="#6e6e6e" d="M5 4h2v1H5zm4 0h2v1H9z"/></svg>`,
  feet: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges"><path fill="#9a9a9a" d="M3 7h4v1h1v5H3V8h0V7zm5 0h4v1h1v5H9V8h0V7zm0 2H4v3h3V9zm5 0H9v3h3V9z"/><path fill="#6e6e6e" d="M4 9h3v1H4zm5 0h3v1H9z"/></svg>`,
  offhand: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges"><path fill="#9a9a9a" d="M7 1h2v1h3v1h1v3h1v4h-1v3h-1v1H8v1H7v-1H4v-1H3v-3H2V6h1V3h1V2h3V1zm1 2H5v1H4v3H3v3h1v2h2v1h3v-1h2v-2h1V7h-1V4h-1V3H8z"/><path fill="#6e6e6e" d="M7 4h2v1H7zm-1 2h4v1H6z"/></svg>`,
};

function armorPlaceholderUrl(kind) {
  const svg = ARMOR_PLACEHOLDER_SVG[kind];
  if (!svg) return "";
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function fillCells(root, slots, bySlot, heldSlot) {
  if (!root) return;
  if (!root.childElementCount) {
    for (const slot of slots) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "inv-cell empty";
      btn.dataset.slot = String(slot);
      const kind = ARMOR_SLOT_KIND[slot];
      if (kind) {
        btn.classList.add("armor-slot");
        btn.dataset.armor = kind;
      }
      btn.innerHTML = `<img class="icon" alt="" draggable="false" hidden /><img class="armor-ph" alt="" draggable="false" /><span class="tag"></span><span class="qty"></span><span class="wear" hidden><i></i></span>`;
      const ph = btn.querySelector("img.armor-ph");
      if (ph && kind) {
        ph.src = armorPlaceholderUrl(kind);
        ph.alt = SLOT_LABELS[slot] || kind;
        ph.removeAttribute("hidden");
        ph.hidden = false;
      } else if (ph) {
        ph.hidden = true;
      }
      root.append(btn);
    }
  }
  for (const btn of root.querySelectorAll(".inv-cell")) {
    const slot = Number(btn.dataset.slot);
    const item = bySlot.get(slot);
    const tag = btn.querySelector(".tag");
    const qty = btn.querySelector(".qty");
    const wear = btn.querySelector(".wear");
    let icon = btn.querySelector("img.icon");
    let ph = btn.querySelector("img.armor-ph");
    const kind = ARMOR_SLOT_KIND[slot];
    if (!icon) {
      icon = document.createElement("img");
      icon.className = "icon";
      icon.alt = "";
      icon.draggable = false;
      icon.hidden = true;
      btn.prepend(icon);
    }
    if (kind) {
      btn.classList.add("armor-slot");
      btn.dataset.armor = kind;
      if (!ph) {
        ph = document.createElement("img");
        ph.className = "armor-ph";
        ph.alt = SLOT_LABELS[slot] || kind;
        ph.draggable = false;
        ph.src = armorPlaceholderUrl(kind);
        icon.after(ph);
      } else if (!ph.getAttribute("src") || !String(ph.getAttribute("src")).startsWith("data:")) {
        // Upgrade any old CDN-based placeholders to embedded SVGs
        ph.src = armorPlaceholderUrl(kind);
      }
    }
    btn.classList.toggle("empty", !item);
    btn.classList.toggle("held", slot === heldSlot);
    btn.classList.toggle("on", slot === selectedSlot);
    btn.classList.remove("invalid-target");
    const label = itemLabel(item);
    const emptyLabel = SLOT_LABELS[slot] ? `empty ${SLOT_LABELS[slot]}` : `empty ${slot}`;
    btn.title = item
      ? `${label} ×${item.count}${item.maxDurability != null ? ` · durability ${Math.max(0, (item.maxDurability - (item.durabilityUsed || 0)))}/${item.maxDurability}` : ""}`
      : emptyLabel;
    btn.style.background = "";
    if (item) {
      setItemIcon(icon, item.name || label);
      if (ph) {
        ph.hidden = true;
        ph.setAttribute("hidden", "");
      }
    } else {
      icon.hidden = true;
      icon.removeAttribute("src");
      icon.dataset.iconId = "";
      btn.classList.remove("no-icon");
      if (ph && kind) {
        ph.src = armorPlaceholderUrl(kind);
        ph.removeAttribute("hidden");
        ph.hidden = false;
      }
    }
    tag.textContent = item ? shortTag(item.name || label) : "";
    qty.textContent = item && item.count > 1 ? String(item.count) : "";
    if (item?.maxDurability) {
      wear.hidden = false;
      const left = 1 - (item.durabilityUsed || 0) / item.maxDurability;
      wear.querySelector("i").style.width = `${Math.max(4, left * 100)}%`;
      wear.querySelector("i").style.background = left < 0.25 ? "var(--blood)" : "var(--moss)";
    } else {
      wear.hidden = true;
    }
  }
  // Highlight illegal targets while an item is selected (armor rules)
  if (selectedSlot != null) {
    const selected = bySlot.get(selectedSlot);
    if (selected) {
      for (const btn of root.querySelectorAll(".inv-cell")) {
        const slot = Number(btn.dataset.slot);
        if (slot === selectedSlot) continue;
        if (!itemFitsSlot(selected.name, slot)) btn.classList.add("invalid-target");
      }
    }
  }
}

function renderOpenWindow(win) {
  const card = document.getElementById("homes-window-card");
  const grid = document.getElementById("homes-window-grid");
  const titleEl = document.getElementById("homes-window-title");
  const hintEl = document.getElementById("homes-window-hint");
  if (!card || !grid) return;
  if (!win || !Array.isArray(win.slots) || win.slots.length === 0) {
    // Keep card if we intentionally showed a fallback list
    if (card.dataset.fallback === "1") return;
    card.hidden = true;
    grid.replaceChildren();
    return;
  }
  card.dataset.fallback = "0";
  card.hidden = false;
  if (titleEl) titleEl.textContent = win.title || "Window";
  const isHomes = /home/i.test(String(win.title || ""));
  if (hintEl) {
    hintEl.textContent = isHomes
      ? "click a home to teleport (same as in-game /homes)"
      : "click a slot in the open window";
  }
  // Learn home names from named items in the GUI
  const homeNames = [];
  for (const item of win.slots) {
    const label = itemLabel(item);
    if (label && label !== "item" && !/^minecraft:/.test(label)) homeNames.push(label);
  }
  if (isHomes) replaceHomes(homeNames, selectedBotId);

  grid.replaceChildren();
  // Sort by slot so layout matches the chest order
  const ordered = [...win.slots].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
  for (const item of ordered) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "home-btn";
    btn.dataset.slot = String(item.slot);
    const name = document.createElement("span");
    name.className = "home-name";
    name.textContent = itemLabel(item) || `slot ${item.slot}`;
    const meta = document.createElement("span");
    meta.className = "home-slot";
    meta.textContent = `#${item.slot}`;
    btn.append(name, meta);
    btn.title = `${itemLabel(item)} (slot ${item.slot})`;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await invOp("windowClick", { slot: item.slot, mouseButton: 0 });
      } finally {
        btn.disabled = false;
      }
    });
    grid.append(btn);
  }
}

/** Render the Homes button grid (from show_dialog or local cache). */
function showHomesDialogPanel(title, homes) {
  const names = (Array.isArray(homes) ? homes : [])
    .map((h) => String(h || "").trim())
    .filter((h) => h && !/^(cancel|close|back|exit)$/i.test(h));
  replaceHomes(names, selectedBotId);
  const card = document.getElementById("homes-window-card");
  const grid = document.getElementById("homes-window-grid");
  const titleEl = document.getElementById("homes-window-title");
  const hintEl = document.getElementById("homes-window-hint");
  if (!card || !grid) return;
  if (!names.length) {
    card.hidden = true;
    card.dataset.fallback = "0";
    grid.replaceChildren();
    return;
  }
  card.dataset.fallback = "0";
  card.hidden = false;
  if (titleEl) titleEl.textContent = title || "Homes";
  if (hintEl) hintEl.textContent = "click a home to run /home";
  grid.replaceChildren();
  for (const homeName of names) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "home-btn";
    const name = document.createElement("span");
    name.className = "home-name";
    name.textContent = homeName;
    const meta = document.createElement("span");
    meta.className = "home-slot";
    meta.textContent = "/home";
    btn.append(name, meta);
    btn.title = `/home ${homeName}`;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await rpc("command", { command: `home ${homeName}` });
        push("sys", `/home ${homeName}`);
      } finally {
        btn.disabled = false;
      }
    });
    grid.append(btn);
  }
}

/** When the server does not open a chest GUI, show known homes as /home buttons. */
async function showHomesFallbackPanel() {
  try {
    const res = await rpc("homes");
    if (res.ok && Array.isArray(res.data)) replaceHomes(res.data, selectedBotId);
  } catch {
    /* ignore */
  }
  const names = [...homesSetFor(selectedBotId)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  showHomesDialogPanel("Homes", names);
  const hintEl = document.getElementById("homes-window-hint");
  if (hintEl && names.length) hintEl.textContent = "click a home to run /home (from known list)";
  const card = document.getElementById("homes-window-card");
  if (card && names.length) card.dataset.fallback = "1";
}

function renderInventory(data) {
  packView = asInvView(data);
  const bySlot = slotMap(packView.slots);
  const heldSlot = 36 + (packView.quickBarSlot || 0);
  fillCells(document.getElementById("inv-gear"), [5, 6, 7, 8], bySlot, heldSlot);
  fillCells(document.getElementById("inv-offhand"), [45], bySlot, heldSlot);
  fillCells(
    document.getElementById("inv-main"),
    Array.from({ length: 27 }, (_, i) => 9 + i),
    bySlot,
    heldSlot,
  );
  fillCells(
    document.getElementById("inv-hot"),
    Array.from({ length: 9 }, (_, i) => 36 + i),
    bySlot,
    heldSlot,
  );
  const held = packView.held;
  const heldEl = document.getElementById("pack-held");
  if (heldEl) {
    heldEl.textContent = held ? `${itemLabel(held)} ×${held.count}` : "hands empty";
  }
  const selected = selectedSlot == null ? null : bySlot.get(selectedSlot);
  const nameEl = document.getElementById("inv-name");
  if (nameEl) {
    const touch = isTouchInventoryUi();
    if (selectedSlot == null) {
      nameEl.textContent = touch
        ? "tap a slot · tap another to move · long-press = equip/hold"
        : "click a slot · click another to move · shift = toss · right-click = drop 1";
    } else if (selected) {
      const fit = equipmentSlotForItem(selected.name);
      const extra = fit != null ? ` · armor → ${SLOT_LABELS[fit]}` : "";
      nameEl.textContent = `${itemLabel(selected)} ×${selected.count}  (slot ${selectedSlot})${extra}`;
    } else {
      const kind = SLOT_LABELS[selectedSlot];
      const verb = touch ? "tap" : "click";
      nameEl.textContent = kind
        ? `empty ${kind} · ${verb} an item to move here`
        : `empty slot ${selectedSlot} · ${verb} an item to move here`;
    }
  }
  renderOpenWindow(packView.window);
  updateInventorySkin();
}

async function invOp(op, extra = {}) {
  const res = await rpc("inv", { op, ...extra });
  if (res.ok && res.data) renderInventory(res.data);
  else await refresh();
}

function selectedOrThrow() {
  if (selectedSlot == null) {
    push("err", "pick an inventory slot first");
    return null;
  }
  return selectedSlot;
}

function botQuery() {
  return selectedBotId ? `?botId=${encodeURIComponent(selectedBotId)}` : "";
}

let lastPlayersInvFetch = 0;

function activeDashboardTab() {
  const panel = document.querySelector(".tab-panel:not([hidden])");
  return panel?.getAttribute("data-tab") || "play";
}

/**
 * Live dashboard refresh.
 * Status is also pushed on the WebSocket — HTTP is a backup.
 * Players/inventory payloads are larger; only fetch them on the Play tab
 * and at a slower cadence so mobile data stays reasonable with 3D off.
 */
async function refresh(opts = {}) {
  if (document.hidden && !opts.force) return;
  try {
    const q = botQuery();
    const tab = activeDashboardTab();
    const onPlay = tab === "play";
    const detailGap = isView3dPrefEnabled() ? 4000 : 8000;
    const wantDetail =
      opts.force ||
      (onPlay && Date.now() - lastPlayersInvFetch >= detailGap);

    const jobs = [
      fetch(`/v1/status${q}`, { credentials: "same-origin", headers: headers() }).then((r) =>
        r.json(),
      ),
    ];
    if (wantDetail) {
      jobs.push(
        fetch(`/v1/players${q}`, { credentials: "same-origin", headers: headers() })
          .then((r) => r.json())
          .catch(() => ({})),
        fetch(`/v1/inventory${q}`, { credentials: "same-origin", headers: headers() })
          .then((r) => r.json())
          .catch(() => ({})),
      );
    }

    const results = await Promise.all(jobs);
    const st = results[0];
    if (st.ok) renderStatus(st.data);
    else if (
      st.error &&
      st.error !== "No bot running. Add an account and fleetStart it, or fleetStartAll."
    ) {
      push(
        "err",
        st.error === "unauthorized"
          ? "unauthorized · refresh http://127.0.0.1:37637/"
          : st.error,
      );
    }

    if (wantDetail) {
      lastPlayersInvFetch = Date.now();
      const players = results[1] || {};
      const inv = results[2] || {};
      if (players.ok) {
        renderPlayers(players.data);
        window.fractalSurvey?.setPlayers(players.data);
      }
      if (inv.ok) renderInventory(inv.data);
    }
  } catch {
    push("err", "control API is down · bot process not running");
  }
}

const VIEW3D_PREF_KEY = "fractal.view3dEnabled";
const VIEW3D_QUALITY_KEY = "fractal.view3dQuality";

function isView3dPrefEnabled() {
  try {
    const v = localStorage.getItem(VIEW3D_PREF_KEY);
    // Default OFF — terrain polling is the heavy data path on mobile
    if (v === null) return false;
    return v === "1" || v === "true";
  } catch {
    return false;
  }
}

function setView3dPref(on) {
  try {
    localStorage.setItem(VIEW3D_PREF_KEY, on ? "1" : "0");
  } catch {
    /* private mode */
  }
  applyView3dState();
}

function getView3dQuality() {
  try {
    if (localStorage.getItem(VIEW3D_QUALITY_KEY) === "full") return "full";
  } catch {
    /* ignore */
  }
  return "lite"; // default: low-bandwidth
}

function setView3dQuality(q) {
  const next = q === "full" ? "full" : "lite";
  try {
    localStorage.setItem(VIEW3D_QUALITY_KEY, next);
  } catch {
    /* ignore */
  }
  const sel = document.getElementById("view3d-quality");
  if (sel) sel.value = next;
  const liteBtn = document.getElementById("view3d-quality-lite");
  const fullBtn = document.getElementById("view3d-quality-full");
  if (liteBtn) liteBtn.classList.toggle("on", next === "lite");
  if (fullBtn) fullBtn.classList.toggle("on", next === "full");
  applyView3dState();
  void refreshVoxels();
}

/** Bot is connected / running so a terrain fetch is useful. */
function isBotLiveForView() {
  if (selectedBotId && fleetState?.bots) {
    const bot = fleetState.bots.find((b) => b.id === selectedBotId);
    if (bot) {
      // Explicit online-off → stop 3D immediately (even if still disconnecting)
      if (bot.features && bot.features.online === false) return false;
      if (bot.bot?.connected) return true;
      return false;
    }
  }
  return Boolean(status?.connected);
}

function applyView3dState() {
  const prefOn = isView3dPrefEnabled();
  const want = prefOn && isBotLiveForView();
  const shared = document.getElementById("survey-shared");
  if (shared) {
    // Only hide the canvas stage when off — toolbar + gamepad stay usable
    shared.classList.toggle("view3d-off", !want);
  }
  try {
    window.fractalSurvey?.setEnabled?.(want);
  } catch {
    /* survey may not be ready */
  }
  const onBtn = document.getElementById("survey-3d-on");
  const offBtn = document.getElementById("survey-3d-off");
  if (onBtn) onBtn.classList.toggle("on", prefOn);
  if (offBtn) offBtn.classList.toggle("on", !prefOn);
  const meta = document.getElementById("survey-meta");
  if (meta && !prefOn) meta.textContent = "3D off · gamepad still works";
  else if (meta && prefOn && !isBotLiveForView()) meta.textContent = "3D paused · bot offline";
}

async function refreshVoxels() {
  if (!window.fractalSurvey) return;
  // No preference or bot offline → do not hit /v1/voxels (saves mobile data)
  if (!isView3dPrefEnabled() || !isBotLiveForView()) {
    applyView3dState();
    return;
  }
  try {
    // Use the radius the user picked on the 3D toolbar (12 / 16 / 20 / 28 / 40)
    const r = Math.max(4, Math.min(48, Number(window.fractalSurvey.radius) || 20));
    // "full" mesh when radius is larger so far blocks still look OK
    const quality = r >= 24 ? "full" : getView3dQuality();
    const qs = new URLSearchParams();
    qs.set("r", String(r));
    qs.set("q", quality);
    if (selectedBotId) qs.set("botId", selectedBotId);
    const res = await fetch(`/v1/voxels?${qs}`, {
      credentials: "same-origin",
      headers: headers(),
    }).then((row) => row.json());
    if (res.ok) window.fractalSurvey.setField(res.data);
  } catch {
    /* bot may be between worlds */
  }
}

function connectEvents() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/v1/events`;
  const ws = new WebSocket(url);
  const label = document.getElementById("ws-state");
  ws.addEventListener("open", () => {
    label.textContent = "socket live";
    label.classList.add("hot");
  });
  ws.addEventListener("close", () => {
    label.textContent = "socket cold";
    label.classList.remove("hot");
    setTimeout(connectEvents, 2000);
  });
  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.event === "status") {
      if (isActiveBotEvent(msg.data)) renderStatus(msg.data);
      // Surface lastChat from status if live chat event was missed
      const lc = msg.data?.lastChat;
      if (lc && isActiveBotEvent(msg.data) && lc !== lastSeenChat) {
        lastSeenChat = lc;
        push("", lc);
      }
    }
    if (msg.event === "phase") {
      if (!isActiveBotEvent(msg.data)) return;
      const phaseVal = msg.data?.value ?? msg.data;
      const phaseEl = document.getElementById("phase");
      if (phaseEl) phaseEl.textContent = String(phaseVal ?? "");
      push("sys", `phase ${phaseVal}`);
    }
    if (msg.event === "chat") {
      const chatBotId = eventBotId(msg.data) || selectedBotId || "";
      // Always store on the owning profile's wire (even when another profile is selected)
      const raw = msg.data?.raw ?? (typeof msg.data === "string" ? msg.data : "");
      if (!raw) return;
      if (isActiveBotEvent(msg.data)) lastSeenChat = raw;
      push("", raw, undefined, chatBotId);
      // Learn home names from chat lines so /home suggestions work without server tab-complete
      const hm = String(raw).match(/\bhomes?\s*(?:\([^)]*\))?\s*[:\-–]\s*(.+)$/i);
      if (hm?.[1]) {
        const parts = hm[1].split(/[,|;]+/).map((s) => s.trim().replace(/^['"]+|['"]+$/g, "").split(/\s+/)[0]);
        rememberHomes(parts.filter((n) => n && /^[A-Za-z0-9_]{1,32}$/.test(n)), chatBotId);
      }
      const setm = String(raw).match(/\b(?:home\s+set|set\s+home)[:\s]+['"]?([A-Za-z0-9_]{1,32})/i);
      if (setm?.[1]) rememberHomes([setm[1]], chatBotId);
    }
    if (msg.event === "window") {
      if (!isActiveBotEvent(msg.data) && msg.data?.botId) {
        /* still allow if no botId filter match helpers need */
      }
      const inv = msg.data?.inventory;
      if (inv) {
        renderInventory(inv);
        const wid = eventBotId(msg.data) || selectedBotId;
        if (Array.isArray(inv.homes)) replaceHomes(inv.homes, wid);
        if (inv.homesDialog?.homes?.length) {
          replaceHomes(inv.homesDialog.homes, wid);
          if (!wid || wid === selectedBotId) {
            showHomesDialogPanel(inv.homesDialog.title || "Homes", inv.homesDialog.homes);
          }
        }
      }
      if (msg.data?.kind === "homesDialog" && Array.isArray(msg.data.homes)) {
        const hid = eventBotId(msg.data) || selectedBotId;
        replaceHomes(msg.data.homes, hid);
        if (!hid || hid === selectedBotId) showHomesDialogPanel(msg.data.title || "Homes", msg.data.homes);
      }
      if (msg.data?.open === false) {
        const card = document.getElementById("homes-window-card");
        if (card && card.dataset.fallback !== "1") {
          card.hidden = true;
        }
      }
    }
    if (msg.event === "kicked") {
      if (!isActiveBotEvent(msg.data)) return;
      const data = msg.data;
      const reason = typeof data === "string" ? data : data?.reason ?? String(data ?? "unknown");
      const kind = typeof data === "object" && data?.kind ? data.kind : "other";
      const links = typeof data === "object" && Array.isArray(data?.links) ? data.links : [];
      const code = typeof data === "object" && data?.verificationCode ? String(data.verificationCode) : "";
      push("err", `kicked (${kind}): ${reason}${code ? ` code=${code}` : ""}`, links);
      if (kind === "captcha" || links.length > 0) {
        showCaptchaBanner(reason, links, kind, code);
      }
    }
    if (msg.event === "disconnected") {
      if (!isActiveBotEvent(msg.data)) return;
      const val = msg.data?.value ?? msg.data;
      push("err", `disconnected: ${val ?? ""}`);
    }
    if (msg.event === "authenticated") {
      if (!isActiveBotEvent(msg.data)) return;
      push("sys", "authenticated");
      hideMsaCodeBanner();
    }
    if (msg.event === "msaCode") {
      if (!isActiveBotEvent(msg.data)) return;
      const code = msg.data;
      showMsaCodeBanner(code);
      push("sys", `Microsoft code: ${code?.user_code || "?"} — open ${code?.verification_uri || "microsoft.com/link"}`);
      // Copy + open automatically when the dashboard is focused
      try {
        if (code?.user_code && navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(String(code.user_code));
        }
      } catch {
        /* ignore */
      }
      try {
        if (code?.verification_uri) {
          window.open(String(code.verification_uri), "_blank", "noopener,noreferrer");
        }
      } catch {
        /* ignore */
      }
    }
    if (msg.event === "worldKind") push("sys", `world ${msg.data}`);
    if (msg.event === "portalEntered") push("sys", `portal ${msg.data?.count ?? ""}`);
    if (msg.event === "error" && !msg.data?.lastError) {
      if (!isActiveBotEvent(msg.data)) return;
      push("err", msg.data?.message ?? "error");
    }
    if (msg.event === "detection") {
      if (!isActiveBotEvent(msg.data)) return;
      appendDetectionEvent(msg.data);
      // Refresh nearby list when presence changes
      if (msg.data?.kind === "player_enter" || msg.data?.kind === "player_leave") {
        void refreshDetection();
      }
    }
  });
}

async function syncBotLookToView() {
  // Point the bot the same way as the on-screen camera so forward/back/left/right
  // are always relative to where the user is looking (not a stale entity yaw).
  try {
    const moving = keys.forward || keys.back || keys.left || keys.right;
    if (!moving) return;
    window.fractalSurvey?.ensureFollow?.();
    const look = window.fractalSurvey?.getLook?.();
    if (!look || typeof look.yaw !== "number") return;
    await rpc("look", { yaw: look.yaw, pitch: look.pitch ?? 0, force: true });
  } catch {
    /* survey / bot may not be ready */
  }
}

async function sendControl() {
  const packed = JSON.stringify(keys);
  if (packed === lastControl) return;
  lastControl = packed;
  const anyMove = keys.forward || keys.back || keys.left || keys.right;
  if (anyMove) await syncBotLookToView();
  await rpc("control", { state: keys });
  // Full stop when nothing is held (also clears pathfinder goals if stuck)
  if (!Object.values(keys).some(Boolean)) {
    try {
      await rpc("stop", {});
    } catch {
      /* ignore */
    }
  }
}

/** Release every held movement/look control (focus loss, tab hide, safety). */
function releaseAllControls(reason) {
  let changed = false;
  for (const k of Object.keys(keys)) {
    if (keys[k]) {
      keys[k] = false;
      changed = true;
    }
  }
  document.querySelectorAll("#gamepad [data-k].down, #gamepad [data-turn].down").forEach((el) => {
    el.classList.remove("down");
  });
  // Stop continuous look intervals if any stuck
  try {
    window.__fractalClearLookTimers?.();
  } catch {
    /* ignore */
  }
  try {
    window.fractalSurvey?.clearLookPrediction?.();
  } catch {
    /* ignore */
  }
  window.__fractalControlsActive = false;
  if (changed || reason) {
    lastControl = "";
    void sendControl();
  }
}

window.addEventListener("blur", () => releaseAllControls("blur"));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) releaseAllControls("hidden");
});
window.addEventListener("pagehide", () => releaseAllControls("pagehide"));


/* On-screen gamepad (under 3D view) — hold movement mods, press actions */
// Shared so voxel poll can speed up while the user is actively steering
window.__fractalControlsActive = false;

(function bindGamepad() {
  // Track active look so we can keep the camera in sync and poll pose faster
  let activeLookCount = 0;
  let posePollTimer = null;

  const anyControlActive = () =>
    activeLookCount > 0 || Object.values(keys).some(Boolean);

  const markActive = () => {
    window.__fractalControlsActive = anyControlActive();
  };

  const startPosePoll = () => {
    if (posePollTimer) return;
    const tick = async () => {
      if (!anyControlActive()) {
        if (posePollTimer) {
          clearInterval(posePollTimer);
          posePollTimer = null;
        }
        return;
      }
      try {
        const body = await rpc("status", {});
        const data = body?.data;
        if (data?.position) {
          window.fractalSurvey?.setBot?.(data.position, data.yaw, data.username, data.pitch);
        }
      } catch {
        /* ignore transient */
      }
    };
    void tick();
    posePollTimer = setInterval(tick, 90);
  };

  const pressKey = (control, down) => {
    if (!control || !(control in keys)) return;
    if (down) {
      if (keys[control]) return;
      keys[control] = true;
      document.querySelectorAll(`[data-k="${control}"]`).forEach((el) => el.classList.add("down"));
      // Always drive the bot relative to the view the user is seeing
      try {
        window.fractalSurvey?.ensureFollow?.();
      } catch {
        /* survey may not be ready */
      }
      startPosePoll();
    } else {
      if (!keys[control]) return;
      keys[control] = false;
      document.querySelectorAll(`[data-k="${control}"]`).forEach((el) => el.classList.remove("down"));
    }
    markActive();
    void sendControl();
  };

  const bindHold = (el, onDown, onUp) => {
    let held = false;
    const down = (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (held) return;
      held = true;
      el.classList.add("down");
      onDown();
    };
    const up = (e) => {
      if (e) e.preventDefault();
      if (!held) return;
      held = false;
      el.classList.remove("down");
      onUp();
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("lostpointercapture", up);
  };

  // Movement + stance (forward/back/left/right/jump/sneak/sprint)
  document.querySelectorAll("#gamepad [data-k]").forEach((el) => {
    const control = el.getAttribute("data-k");
    bindHold(
      el,
      () => pressKey(control, true),
      () => pressKey(control, false),
    );
  });

  // Look — hold to keep turning (faster ticks + local prediction for smooth feel)
  const lookTimers = new Map();
  const LOOK_INTERVAL_MS = 45;
  window.__fractalClearLookTimers = () => {
    for (const id of lookTimers.values()) clearInterval(id);
    lookTimers.clear();
    activeLookCount = 0;
  };
  document.querySelectorAll("#gamepad [data-turn]").forEach((el) => {
    const raw = el.getAttribute("data-turn") || "0,0";
    const [yawS, pitchS] = raw.split(",");
    // Smaller steps at higher rate ≈ same turn speed, much smoother
    // Pitch gets a slightly higher scale so look up/down feels as strong as left/right
    const yaw = (Number(yawS) || 0) * 0.42;
    const pitch = (Number(pitchS) || 0) * 0.55;
    bindHold(
      el,
      () => {
        activeLookCount += 1;
        try {
          window.fractalSurvey?.ensureFollow?.();
        } catch {
          /* ignore */
        }
        const tick = () => {
          // In 1st person, left/right feel inverted vs 3rd-person over-the-shoulder —
          // flip yaw so ◀ / ▶ match what you see on screen.
          let turnYaw = yaw;
          try {
            if (window.fractalSurvey?.getPerson?.() === "first" || window.fractalSurvey?.person === "first") {
              turnYaw = -yaw;
            }
          } catch {
            /* ignore */
          }
          // Instant local camera response (yaw + pitch)
          try {
            window.fractalSurvey?.nudgeLook?.(turnYaw, pitch);
          } catch {
            /* ignore */
          }
          void rpc("turn", { yaw: turnYaw, pitch });
          // If the user is already holding a move key, re-sync facing so
          // strafe/forward stay aligned with the new look direction.
          if (keys.forward || keys.back || keys.left || keys.right) {
            void syncBotLookToView();
          }
        };
        tick();
        const id = setInterval(tick, LOOK_INTERVAL_MS);
        lookTimers.set(el, id);
        startPosePoll();
        markActive();
      },
      () => {
        activeLookCount = Math.max(0, activeLookCount - 1);
        const id = lookTimers.get(el);
        if (id) clearInterval(id);
        lookTimers.delete(el);
        if (activeLookCount === 0) {
          try {
            window.fractalSurvey?.clearLookPrediction?.();
          } catch {
            /* ignore */
          }
        }
        markActive();
      },
    );
  });

  // L / R — same roles as mouse buttons in Minecraft
  const clickTimers = new Map();
  document.querySelectorAll("#gamepad [data-click]").forEach((el) => {
    const side = el.getAttribute("data-click");
    if (side === "left") {
      // Left: attack + dig while held
      bindHold(
        el,
        () => {
          void rpc("attack", {});
          void rpc("dig", {}).catch(() => {});
          void rpc("swing", {}).catch(() => {});
          clickTimers.set(
            el,
            setInterval(() => {
              void rpc("attack", {});
            }, 350),
          );
        },
        () => {
          const id = clickTimers.get(el);
          if (id) clearInterval(id);
          clickTimers.delete(el);
          void rpc("stopDig", {}).catch(() => {});
        },
      );
      return;
    }
    if (side === "right") {
      // Right: place / use item / activate
      bindHold(
        el,
        () => {
          void rpc("place", {}).catch(() => {});
          void invOp("use", {}).catch(() => {});
          void rpc("activate", {}).catch(() => {});
        },
        () => {},
      );
    }
  });
})();

function surveyOwnsKeys() {
  return window.fractalSurvey?.ownsKeys?.() ?? false;
}

function clearBotKeys() {
  let any = false;
  for (const name of Object.keys(keys)) {
    if (!keys[name]) continue;
    keys[name] = false;
    any = true;
    document.querySelectorAll(`[data-k="${name}"]`).forEach((el) => el.classList.remove("down"));
  }
  if (any) void sendControl();
}

document.querySelectorAll("[data-rpc]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const action = btn.getAttribute("data-rpc");
    if (action === "join") await rpc("join", { options: {} });
    else if (action === "leave") await rpc("leave", { reason: "dashboard" });
    else if (action === "mapStart") {
      const body = await rpc("mapStart", {});
      push("sys", `map start: ${body.data?.result ?? JSON.stringify(body.data ?? body)}`);
      logActivity(`map start ${body.data?.result ?? ""}`);
    } else if (action === "mapStop") {
      const body = await rpc("mapStop", {});
      push("sys", `map stop: ${body.data?.result ?? JSON.stringify(body.data ?? body)}`);
      logActivity("map stop");
    } else {
      await rpc(action);
      if (["join", "leave", "reconnect", "hunt"].includes(action)) logActivity(action);
    }
    await refresh();
  });
});

document.getElementById("captcha-dismiss")?.addEventListener("click", () => {
  hideCaptchaBanner();
});

// Captcha notify: change-only (no click handler — click+change used to fight each other)

document.getElementById("say").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.getElementById("say-input");
  const text = input.value.trim();
  if (!text) return;
  await sendWireMessage(text);
  input.value = "";
});

document.getElementById("goto").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const x = Number(form.x.value);
  const y = Number(form.y.value);
  const z = Number(form.z.value);
  if (![x, y, z].every(Number.isFinite)) {
    push("err", "goto needs numeric x y z");
    return;
  }
  await rpc("goto", { x, y, z });
});

window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement) return;
  const digit = event.code.match(/^Digit([1-9])$/);
  if (digit) {
    event.preventDefault();
    const slot = 35 + Number(digit[1]);
    selectedSlot = slot;
    void invOp("hold", { slot });
    return;
  }
  if (surveyOwnsKeys()) return;
  if (selectedSlot != null && event.code === "KeyQ") {
    event.preventDefault();
    void invOp(event.shiftKey ? "dropStack" : "drop", { slot: selectedSlot });
    return;
  }
  const control = keyMap[event.code];
  if (!control) return;
  event.preventDefault();
  if (keys[control]) return;
  keys[control] = true;
  document.querySelectorAll(`[data-k="${control}"]`).forEach((el) => el.classList.add("down"));
  try {
    window.fractalSurvey?.ensureFollow?.();
  } catch {
    /* ignore */
  }
  window.__fractalControlsActive = true;
  void sendControl();
});

window.addEventListener("keyup", (event) => {
  const control = keyMap[event.code];
  if (!control) return;
  if (!keys[control]) return;
  keys[control] = false;
  document.querySelectorAll(`[data-k="${control}"]`).forEach((el) => el.classList.remove("down"));
  window.__fractalControlsActive = Object.values(keys).some(Boolean);
  void sendControl();
});

/** True on phones / tablets (coarse pointer or touch points). */
function isTouchInventoryUi() {
  try {
    if (window.matchMedia?.("(pointer: coarse)").matches) return true;
    if (navigator.maxTouchPoints > 0) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function updateInvHintForDevice() {
  const el = document.getElementById("inv-hint");
  if (!el) return;
  if (isTouchInventoryUi()) {
    el.textContent =
      "Tap to select, tap another slot to move. Long-press to equip or hold. Use the buttons on the selected slot. Armor only accepts the matching piece.";
  } else {
    el.textContent =
      "Click to select, click another to move. Shift = toss · right-click = drop 1 · double-click = hold/equip. Armor only accepts the matching piece. Keys 1–9 select hotbar.";
  }
}
updateInvHintForDevice();

async function invActivateSlot(slot, { shift = false, alt = false, secondary = false } = {}) {
  if (!Number.isFinite(slot)) return;
  const by = slotMap(packView.slots);
  const item = by.get(slot);

  // Shift / secondary long-press on desktop modifiers — only on occupied slots
  if (shift) {
    if (!item) {
      push("err", "slot is empty");
      return;
    }
    selectedSlot = slot;
    if (isArmorOnlyItem(item.name) && !ARMOR_SLOTS.has(slot)) {
      await invOp("equip", { slot });
      return;
    }
    await invOp("dropStack", { slot });
    return;
  }
  if (alt) {
    if (!item) {
      push("err", "slot is empty");
      return;
    }
    selectedSlot = slot;
    await invOp("drop", { slot, count: 1 });
    return;
  }
  // Secondary (long-press / right-click): equip armor or hold, else drop 1
  if (secondary) {
    if (!item) {
      // Empty hotbar long-press → switch held hand to that slot
      if (slot >= 36 && slot <= 44) {
        selectedSlot = slot;
        renderInventory(packView);
        await invOp("hold", { slot });
        return;
      }
      selectedSlot = null;
      renderInventory(packView);
      return;
    }
    selectedSlot = slot;
    if (isArmorOnlyItem(item.name) && !ARMOR_SLOTS.has(slot)) {
      await invOp("equip", { slot });
      return;
    }
    if (!ARMOR_SLOTS.has(slot) && slot !== 45) {
      await invOp("hold", { slot });
      return;
    }
    await invOp("drop", { slot, count: 1 });
    return;
  }

  // Move / swap when a source is already selected
  if (selectedSlot != null && selectedSlot !== slot) {
    const fromItem = by.get(selectedSlot);
    // Source went empty (or was empty) — drop selection, don't move
    if (!fromItem) {
      selectedSlot = null;
      renderInventory(packView);
      return;
    }
    const check = canSwapSlots(selectedSlot, slot, by);
    if (!check.ok) {
      push("err", check.reason || "cannot move that item there");
      renderInventory(packView);
      return;
    }
    const from = selectedSlot;
    selectedSlot = null;
    await invOp("swap", { slot: from, to: slot });
    return;
  }

  // Toggle selection
  if (selectedSlot === slot) {
    selectedSlot = null;
    renderInventory(packView);
    return;
  }

  // Empty slots: only hotbar (36–44) may be selected so you can switch the held hand
  if (!item) {
    const isHotbar = slot >= 36 && slot <= 44;
    if (!isHotbar) {
      selectedSlot = null;
      renderInventory(packView);
      return;
    }
    selectedSlot = slot;
    renderInventory(packView);
    // Switch active quick-bar slot even when empty
    await invOp("hold", { slot });
    return;
  }

  selectedSlot = slot;
  renderInventory(packView);
}

async function invDoubleActivate(slot) {
  const by = slotMap(packView.slots);
  const item = by.get(slot);
  if (!item) {
    if (slot >= 36 && slot <= 44) {
      selectedSlot = slot;
      renderInventory(packView);
      await invOp("hold", { slot });
      return;
    }
    selectedSlot = null;
    renderInventory(packView);
    return;
  }
  selectedSlot = slot;
  if (isArmorOnlyItem(item.name) && !ARMOR_SLOTS.has(slot)) {
    await invOp("equip", { slot });
  } else {
    await invOp("hold", { slot });
  }
}

// —— Pointer-based inventory (works on mobile + desktop) ——
(function setupInvPointers() {
  const root = document.getElementById("inv");
  if (!root) return;

  const LONG_MS = 480;
  const DOUBLE_MS = 320;
  let pressTimer = null;
  let pressBtn = null;
  let pressSlot = null;
  let longFired = false;
  let lastTapSlot = null;
  let lastTapAt = 0;
  let suppressClickUntil = 0;

  function clearPress() {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
    if (pressBtn) pressBtn.classList.remove("pressing");
    pressBtn = null;
    pressSlot = null;
  }

  root.addEventListener(
    "pointerdown",
    (event) => {
      const btn = event.target.closest(".inv-cell");
      if (!btn || !root.contains(btn)) return;
      // Only primary button / touch
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const slot = Number(btn.dataset.slot);
      if (!Number.isFinite(slot)) return;

      longFired = false;
      pressBtn = btn;
      pressSlot = slot;
      btn.classList.add("pressing");
      try {
        btn.setPointerCapture?.(event.pointerId);
      } catch {
        /* ignore */
      }

      pressTimer = setTimeout(() => {
        pressTimer = null;
        longFired = true;
        if (pressBtn) pressBtn.classList.remove("pressing");
        // Haptic feedback when available
        try {
          navigator.vibrate?.(12);
        } catch {
          /* ignore */
        }
        void invActivateSlot(slot, { secondary: true });
      }, LONG_MS);
    },
    { passive: true },
  );

  function endPress(event) {
    const slot = pressSlot;
    const wasLong = longFired;
    const btn = pressBtn;
    clearPress();
    if (btn) {
      try {
        btn.releasePointerCapture?.(event.pointerId);
      } catch {
        /* ignore */
      }
    }
    if (slot == null) return;
    if (wasLong) {
      // Long-press already handled; swallow the following click
      suppressClickUntil = Date.now() + 400;
      lastTapSlot = null;
      return;
    }
    // Short tap — double-tap detect
    const now = Date.now();
    if (lastTapSlot === slot && now - lastTapAt < DOUBLE_MS) {
      lastTapSlot = null;
      lastTapAt = 0;
      suppressClickUntil = now + 400;
      void invDoubleActivate(slot);
      return;
    }
    lastTapSlot = slot;
    lastTapAt = now;
    void invActivateSlot(slot, {
      shift: !!(event.shiftKey),
      alt: !!(event.altKey),
    });
  }

  root.addEventListener("pointerup", endPress);
  root.addEventListener("pointercancel", () => {
    clearPress();
    longFired = false;
  });
  root.addEventListener("pointerleave", (event) => {
    // Only clear if the pointer left the pressed cell
    if (pressBtn && event.target === pressBtn) clearPress();
  });

  // Prevent native context menu on slots (mobile long-press / desktop right-click)
  root.addEventListener("contextmenu", (event) => {
    const btn = event.target.closest(".inv-cell");
    if (!btn) return;
    event.preventDefault();
    // Desktop right-click still drops one when not already handled by long-press path
    if (event.pointerType === "mouse" || (!isTouchInventoryUi() && event.button === 2)) {
      const slot = Number(btn.dataset.slot);
      if (!Number.isFinite(slot)) return;
      void invActivateSlot(slot, { secondary: true });
    }
  });

  // Block synthetic click after long-press / double-tap
  root.addEventListener(
    "click",
    (event) => {
      if (Date.now() < suppressClickUntil) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );
})();

document.querySelectorAll("[data-inv]").forEach((btn) => {
  // Reliable press highlight on iOS/Android (CSS :active alone is flaky)
  const setPress = (on) => btn.classList.toggle("pressing", on);
  btn.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      setPress(true);
      try {
        btn.setPointerCapture?.(e.pointerId);
      } catch {
        /* ignore */
      }
    },
    { passive: true },
  );
  const clearPress = (e) => {
    setPress(false);
    try {
      btn.releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  btn.addEventListener("pointerup", clearPress);
  btn.addEventListener("pointercancel", clearPress);
  btn.addEventListener("pointerleave", () => setPress(false));
  btn.addEventListener("lostpointercapture", () => setPress(false));

  btn.addEventListener("click", async () => {
    setPress(false);
    const slot = selectedOrThrow();
    if (slot == null) return;
    const op = btn.getAttribute("data-inv");
    const by = slotMap(packView.slots);
    const item = by.get(slot);

    // Empty slots: only "hold" on hotbar is allowed (switch active hand)
    if (!item) {
      if (op === "hold" && slot >= 36 && slot <= 44) {
        await invOp("hold", { slot });
        return;
      }
      push("err", "slot is empty");
      if (!(slot >= 36 && slot <= 44)) selectedSlot = null;
      renderInventory(packView);
      return;
    }

    if (op === "offhand") {
      if (isArmorOnlyItem(item.name)) {
        push("err", `${itemLabel(item) || item.name} belongs in armor, not off-hand`);
        return;
      }
      await invOp("equip", { slot, dest: "off-hand" });
      return;
    }

    if (op === "equip") {
      const dest = equipmentSlotForItem(item.name);
      if (dest == null && !["shield", "totem_of_undying"].includes(cleanItemName(item.name))) {
        await invOp("hold", { slot });
        return;
      }
      await invOp("equip", { slot });
      return;
    }

    if (op === "unequip") {
      if (!ARMOR_SLOTS.has(slot) && slot !== 45) {
        push("err", "select an armor or off-hand slot to unequip");
        return;
      }
      await invOp("unequip", { slot });
      return;
    }

    await invOp(op, { slot });
  });
});

document.getElementById("homes-window-close")?.addEventListener("click", async () => {
  const card = document.getElementById("homes-window-card");
  if (card) {
    card.dataset.fallback = "0";
    card.hidden = true;
  }
  try {
    await invOp("windowClose");
  } catch {
    /* no window */
  }
});

window.addEventListener("survey-keys", (event) => {
  if (event.detail?.owns) clearBotKeys();
});

// —— Detection tab (players / crystals / TNT) ——
const detectionEvents = [];
const DETECTION_MAX = 150;

/* —— Detection push notification prefs (this browser) —— */
const DET_NOTIFY_KEYS = {
  playerEnter: "fractal-det-notify-enter",
  playerLeave: "fractal-det-notify-leave",
  combat: "fractal-det-notify-combat",
  crystals: "fractal-det-notify-crystals",
  tnt: "fractal-det-notify-tnt",
  explosions: "fractal-det-notify-explosions",
  onlyHidden: "fractal-det-notify-hidden",
  /** When false (default), never push-notify while bot is in lobby / auth / queue. */
  lobby: "fractal-det-notify-lobby",
};

/** Lobby-like worlds where detection spam is expected (auth island, dual portals, limbo). */
function isLobbyLikeWorld(kind) {
  const k = String(kind || "").toLowerCase();
  return k === "lobby" || k === "auth" || k === "backup" || k === "queue";
}

function detNotifyPref(key, defaultOn) {
  try {
    const v = localStorage.getItem(key);
    if (v === null || v === undefined || v === "") return defaultOn;
    return v === "1" || v === "true";
  } catch {
    return defaultOn;
  }
}

function setDetNotifyPref(key, on) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** Detection notify prefs for the selected profile (server-side profile.notifyPrefs). */
function loadDetNotifyPrefs(bot) {
  const defaults = {
    playerEnter: true,
    playerLeave: false,
    combat: true,
    crystals: false,
    tnt: false,
    explosions: false,
    onlyHidden: true,
    lobby: false,
  };
  const b = bot || (fleetState?.bots || []).find((x) => x.id === selectedBotId);
  const n = (b && b.profile && b.profile.notifyPrefs) || {};
  return {
    playerEnter: typeof n.playerEnter === "boolean" ? n.playerEnter : defaults.playerEnter,
    playerLeave: typeof n.playerLeave === "boolean" ? n.playerLeave : defaults.playerLeave,
    combat: typeof n.combat === "boolean" ? n.combat : defaults.combat,
    crystals: typeof n.crystals === "boolean" ? n.crystals : defaults.crystals,
    tnt: typeof n.tnt === "boolean" ? n.tnt : defaults.tnt,
    explosions: typeof n.explosions === "boolean" ? n.explosions : defaults.explosions,
    onlyHidden: typeof n.onlyHidden === "boolean" ? n.onlyHidden : defaults.onlyHidden,
    lobby: typeof n.lobby === "boolean" ? n.lobby : defaults.lobby,
  };
}

/** Read notify prefs from the detection settings form (saved onto the profile). */
function notifyPrefsFromForm(form) {
  if (!form) return {};
  const boolSel = (v) => v === "true" || v === true;
  return {
    playerEnter: form.notifyPlayerEnter ? boolSel(form.notifyPlayerEnter.value) : true,
    playerLeave: form.notifyPlayerLeave ? boolSel(form.notifyPlayerLeave.value) : false,
    combat: form.notifyCombat ? boolSel(form.notifyCombat.value) : true,
    crystals: form.notifyCrystals ? boolSel(form.notifyCrystals.value) : false,
    tnt: form.notifyTnt ? boolSel(form.notifyTnt.value) : false,
    explosions: form.notifyExplosions ? boolSel(form.notifyExplosions.value) : false,
    onlyHidden: form.notifyOnlyHidden ? boolSel(form.notifyOnlyHidden.value) : true,
    lobby: form.notifyInLobby ? boolSel(form.notifyInLobby.value) : false,
  };
}

function fillDetNotifyForm(form, bot) {
  if (!form) return;
  const p = loadDetNotifyPrefs(bot);
  if (form.notifyPlayerEnter) form.notifyPlayerEnter.value = p.playerEnter ? "true" : "false";
  if (form.notifyPlayerLeave) form.notifyPlayerLeave.value = p.playerLeave ? "true" : "false";
  if (form.notifyCombat) form.notifyCombat.value = p.combat ? "true" : "false";
  if (form.notifyCrystals) form.notifyCrystals.value = p.crystals ? "true" : "false";
  if (form.notifyTnt) form.notifyTnt.value = p.tnt ? "true" : "false";
  if (form.notifyExplosions) form.notifyExplosions.value = p.explosions ? "true" : "false";
  if (form.notifyOnlyHidden) form.notifyOnlyHidden.value = p.onlyHidden ? "true" : "false";
  if (form.notifyInLobby) form.notifyInLobby.value = p.lobby ? "true" : "false";
}

function detectionNotifyWanted(kind) {
  const p = loadDetNotifyPrefs();
  if (kind === "player_enter") return p.playerEnter;
  if (kind === "player_leave") return p.playerLeave;
  if (kind === "attacked" || kind === "death" || kind === "hurt") return p.combat;
  if (kind === "crystal_spawn" || kind === "crystal_gone") return p.crystals;
  if (kind === "tnt_spawn" || kind === "tnt_gone") return p.tnt;
  if (kind === "explosion") return p.explosions;
  return false;
}

function notifyDetection(ev) {
  if (!ev || !ev.kind) return;
  if (!detectionNotifyWanted(ev.kind)) return;
  const prefs = loadDetNotifyPrefs();
  // Lobby / auth / queue: ignore by default (toggle in Detect settings)
  const world = ev.worldKind || status?.worldKind || "";
  if (!prefs.lobby && isLobbyLikeWorld(world)) return;
  if (prefs.onlyHidden && !document.hidden) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const title =
    ev.kind === "player_enter"
      ? "Player nearby"
      : ev.kind === "player_leave"
        ? "Player left range"
        : ev.kind === "attacked" || ev.kind === "hurt"
          ? "Under attack"
          : ev.kind === "death"
            ? "Bot died"
            : ev.kind?.startsWith("crystal")
              ? "Crystal"
              : ev.kind?.startsWith("tnt")
                ? "TNT"
                : ev.kind === "explosion"
                  ? "Explosion"
                  : "Detection";
  const body = String(ev.message || ev.label || ev.kind).slice(0, 160);
  const tag = `fractal-det-${ev.kind}-${ev.label || "x"}`.slice(0, 64);

  const payload = {
    type: "detection-notify",
    title,
    body,
    tag,
    url: "/#detect",
  };

  if (swRegistration?.active) {
    swRegistration.active.postMessage(payload);
    return;
  }
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage(payload);
    return;
  }
  try {
    const n = new Notification(title, {
      body,
      tag,
      renotify: true,
    });
    n.onclick = () => {
      window.focus();
      try {
        location.hash = "detect";
      } catch {
        /* ignore */
      }
      n.close();
    };
  } catch (err) {
    console.warn("detection notification failed", err);
  }
}

function appendDetectionEvent(ev) {
  if (!ev || !ev.message) return;
  const id = ev.id || `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  if (ev.id && detectionSeenIds.has(ev.id)) return;
  // de-dupe identical spam within 300ms
  const head = detectionEvents[0];
  if (
    head &&
    head.kind === ev.kind &&
    head.message === ev.message &&
    Math.abs(new Date(head.at).getTime() - new Date(ev.at || Date.now()).getTime()) < 300
  ) {
    if (ev.id) detectionSeenIds.add(ev.id);
    return;
  }
  if (ev.id) detectionSeenIds.add(ev.id);
  notifyDetection(ev);
  detectionEvents.unshift({
    id,
    at: ev.at || new Date().toISOString(),
    kind: ev.kind || "info",
    message: ev.message,
    label: ev.label,
    position: ev.position,
    distance: ev.distance,
  });
  if (detectionEvents.length > DETECTION_MAX) detectionEvents.length = DETECTION_MAX;
  renderDetectionLog();
}

function renderDetectionLog() {
  const ol = document.getElementById("detect-log");
  if (!ol) return;
  ol.replaceChildren();
  for (const ev of detectionEvents.slice(0, 80)) {
    const li = document.createElement("li");
    li.className = ev.kind || "";
    const time = document.createElement("time");
    time.textContent = fmtLocalFrom(ev.at);
    li.append(time);
    const who = ev.username || ev.player;
    if (who) {
      if (ev.skinUrl) rememberSkinUrl(who, ev.skinUrl);
      else if (skinUrlCache.has(String(who).toLowerCase())) {
        /* already known */
      }
      const av = playerAvatarEl(String(who), ev.skinUrl || skinUrlCache.get(String(who).toLowerCase()), 18);
      av.classList.add("detect-av");
      li.append(av);
    }
    li.append(document.createTextNode(ev.message));
    ol.append(li);
  }
}

/** After an intentional Clear, do not re-hydrate from the server ring buffer. */
let detectionCleared = false;
/** Ids already shown — used to pull only *new* server events after a clear. */
const detectionSeenIds = new Set();

async function refreshDetection() {
  if (!selectedBotId && !status?.connected) return;
  try {
    const body = await rpc("detection", {});
    if (!body.ok || !body.data) return;
    const serverEvents = Array.isArray(body.data.events) ? body.data.events : [];

    if (!detectionEvents.length && !detectionCleared) {
      // Page reload / first open — hydrate full history once
      for (const ev of [...serverEvents].reverse()) {
        if (ev?.id) detectionSeenIds.add(ev.id);
        appendDetectionEvent(ev);
      }
      return;
    }

    // After clear (or while log has items): only append events we have not seen
    for (const ev of [...serverEvents].reverse()) {
      if (!ev?.id || detectionSeenIds.has(ev.id)) continue;
      detectionSeenIds.add(ev.id);
      appendDetectionEvent(ev);
    }
  } catch {
    /* ignore */
  }
}

/** Pull the live hunt status plus the stash and player databases for the Hunt panel. */
async function refreshHunt() {
  if (!selectedBotId && !status?.connected) return;
  const forEl = document.getElementById("hunt-for");
  if (forEl) forEl.textContent = selectedBotId ? `Profile: ${selectedBotId}` : "Live bot";
  try {
    const body = await rpc("huntStatus", {});
    if (!body.ok) return;
    const s = body.data;
    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    if (!s) {
      set("hunt-phase", "idle");
      set("hs-phase", "not started");
      return;
    }
    const flight = s.flight || {};
    set("hunt-phase", s.paused ? "paused" : s.active ? s.phase : "idle");
    set("hs-phase", s.paused ? "paused" : s.active ? s.phase : "stopped");
    set("hs-mode", s.mode || "—");
    set("hs-flight", flight.state || "—");
    set("hs-elytra", flight.elytraRemaining >= 0 ? `${flight.elytraRemaining} left` : "none");
    set("hs-spares", flight.elytraSpares ?? "—");
    set("hs-target", s.target ? `${Math.round(s.target.x)},${Math.round(s.target.y)},${Math.round(s.target.z)}` : "—");
    set("hs-waypoint", `${s.waypointIndex ?? 0} / ${s.waypointsTotal ?? 0}`);
    set("hs-explored", s.exploredChunks ?? 0);
    set("hs-stashes", s.stashes ?? 0);
    set("hs-players", s.players ?? 0);
    const sv = s.survival || null;
    set("hs-health", sv ? sv.health : "—");
    set("hs-food", sv ? sv.food : "—");
    set("hs-totems", sv ? sv.totems : "—");
    set("hs-fireworks", sv ? sv.fireworks : "—");
    set("hs-free", sv ? sv.freeSlots : "—");
    const notes = document.getElementById("hunt-notes");
    if (notes) notes.textContent = (s.notes || []).join(" · ") || "No notes.";
  } catch {
    /* ignore */
  }
  try {
    const stashes = await rpc("stashNearby", {});
    if (stashes.ok && stashes.data) {
      const rows = stashes.data.stashes || [];
      const count = document.getElementById("hunt-stash-count");
      if (count) count.textContent = `${stashes.data.total ?? rows.length} total`;
      const list = document.getElementById("hunt-stash-list");
      if (list) {
        list.replaceChildren();
        for (const row of rows.slice(0, 20)) {
          const li = document.createElement("li");
          li.textContent = `${row.tier} · ${row.score} · ${row.x},${row.z} · ${row.distance ?? "?"}b`;
          list.append(li);
        }
        if (!rows.length) {
          const li = document.createElement("li");
          li.className = "mute";
          li.textContent = "No stashes recorded yet.";
          list.append(li);
        }
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const players = await rpc("playerList", {});
    if (players.ok && players.data) {
      const rows = players.data.players || [];
      const count = document.getElementById("hunt-player-count");
      if (count) count.textContent = `${players.data.total ?? rows.length} total`;
      const list = document.getElementById("hunt-player-list");
      if (list) {
        list.replaceChildren();
        for (const row of rows.slice(0, 20)) {
          const li = document.createElement("li");
          const seen = row.lastSeenMs ? new Date(row.lastSeenMs).toLocaleString() : "?";
          li.textContent = `${row.username} · ${row.sightings}× · ${row.lastX},${row.lastZ} · ${seen}`;
          list.append(li);
        }
        if (!rows.length) {
          const li = document.createElement("li");
          li.className = "mute";
          li.textContent = "No players recorded yet.";
          list.append(li);
        }
      }
    }
  } catch {
    /* ignore */
  }
}

function wireHuntButtons() {
  const run = (action, extra) =>
    rpc(action, extra).then(() => refreshHunt()).catch(() => {});
  document.getElementById("hunt-start")?.addEventListener("click", () => {
    const mode = document.getElementById("hunt-mode")?.value || "spiral";
    void run("huntStart", { huntConfig: { mode } });
  });
  document.getElementById("hunt-pause")?.addEventListener("click", () => void run("huntPause"));
  document.getElementById("hunt-resume")?.addEventListener("click", () => void run("huntResume"));
  document.getElementById("hunt-stop")?.addEventListener("click", () => void run("huntStop"));
  document.getElementById("hunt-restock")?.addEventListener("click", () => void run("huntRestock"));

  const out = document.getElementById("hunt-equipment-output");
  const setOut = (text) => {
    if (out) out.textContent = text;
  };
  const show = async (action, format) => {
    setOut("…");
    try {
      const body = await rpc(action, {});
      if (!body.ok) {
        setOut(`error: ${body.error || "request failed"}`);
        return;
      }
      setOut(format(body.data));
    } catch (e) {
      setOut(`error: ${e?.message || e}`);
    }
  };

  document.getElementById("hunt-elytra-status")?.addEventListener("click", () =>
    void show("elytraStatus", (d) =>
      d ? `equipped=${d.equipped} remaining=${d.remaining} spares=${d.spares} bestSpare=${d.bestSpareRemaining}` : "no elytra data (not connected)",
    ),
  );
  document.getElementById("hunt-elytra-replace")?.addEventListener("click", () =>
    void show("elytraReplace", (d) => `${d?.result ?? "no result"}\n${JSON.stringify(d?.status ?? {}, null, 2)}`),
  );
  document.getElementById("hunt-mending")?.addEventListener("click", () =>
    void show("mendingStatus", (d) => {
      const rows = d?.candidates || [];
      const target = d?.target ? `target: ${d.target.name} slot ${d.target.slot} (${d.target.remaining}/${d.target.maxDamage})` : "target: none";
      return [target, ...rows.map((c) => `${c.name} slot ${c.slot} ${c.remaining}/${c.maxDamage}`)].join("\n");
    }),
  );
  document.getElementById("hunt-survival")?.addEventListener("click", () =>
    void show("survivalStatus", (d) => (d ? JSON.stringify(d, null, 2) : "not connected")),
  );
  document.getElementById("hunt-echest")?.addEventListener("click", () =>
    void show("echestStatus", (d) => (d ? `${d.ok ? "ok" : "failed"}: ${d.result}${d.items != null ? ` (${d.items} slots)` : ""}` : "no result")),
  );
  document.getElementById("hunt-webhook")?.addEventListener("click", () =>
    void show("webhookTest", (d) => d?.result || "no result"),
  );

  const routeOut = document.getElementById("hunt-route-hint");
  const setRouteOut = (text) => {
    if (routeOut) routeOut.textContent = text;
  };
  document.getElementById("hunt-route-set")?.addEventListener("click", async () => {
    const raw = document.getElementById("hunt-route-input")?.value || "";
    const waypoints = [];
    for (const token of raw.split(/[\s;]+/)) {
      const m = token.match(/^(-?\d+)[,:](-?\d+)$/);
      if (m) waypoints.push({ x: Number(m[1]), z: Number(m[2]) });
    }
    if (!waypoints.length) {
      setRouteOut("No waypoints parsed — use `x,z` pairs.");
      return;
    }
    try {
      const body = await rpc("huntRouteSet", { waypoints });
      setRouteOut(body.ok ? `Route set: ${body.data?.count ?? waypoints.length} waypoints.` : `error: ${body.error}`);
      void refreshHunt();
    } catch (e) {
      setRouteOut(`error: ${e?.message || e}`);
    }
  });
  document.getElementById("hunt-route-list")?.addEventListener("click", async () => {
    try {
      const body = await rpc("huntRouteList", {});
      const route = body.ok ? body.data?.route || [] : [];
      setRouteOut(route.length ? route.map((w) => `${w.x},${w.z}`).join("  ") : "Route is empty.");
    } catch (e) {
      setRouteOut(`error: ${e?.message || e}`);
    }
  });
  document.getElementById("hunt-route-clear")?.addEventListener("click", async () => {
    try {
      await rpc("huntRouteSet", { waypoints: [] });
      await rpc("huntConfig", { huntConfig: { mode: "spiral" } });
      setRouteOut("Route cleared — back to spiral mode.");
      void refreshHunt();
    } catch (e) {
      setRouteOut(`error: ${e?.message || e}`);
    }
  });
}
wireHuntButtons();

// --- Kit bot -------------------------------------------------------------------------------------
async function refreshKitBot() {
  if (!selectedBotId && !status?.connected) return;
  const forEl = document.getElementById("kitbot-for");
  if (forEl) forEl.textContent = selectedBotId ? `Profile: ${selectedBotId}` : "Live bot";
  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  try {
    const body = await rpc("kitBotStatus", {});
    if (!body.ok) return;
    const data = body.data || {};
    const cfg = body.data?.config || {};
    const s = data.status || {};
    set("kitbot-state", data.active ? "active" : "stopped");
    const pill = document.getElementById("kitbot-state");
    if (pill) pill.setAttribute("data-tone", data.active ? "live" : "neutral");
    set("kb-active", data.active ? "yes" : "no");
    set("kb-prefix", cfg.prefix ?? "—");
    set("kb-cooldown", cfg.cooldownMs != null ? `${cfg.cooldownMs / 1000}s` : "—");
    set("kb-distance", cfg.maxDistance === 0 ? "anywhere" : cfg.maxDistance ?? "—");
    set("kb-kits", (cfg.kits || []).map((k) => k.name).join(", ") || "—");
    set("kb-served", s.servedTotal ?? 0);
    set("kb-perminute", s.servedLastMinute ?? 0);
    set("kb-oncooldown", s.playersOnCooldown ?? 0);
    // Seed the settings form only when the tab is freshly shown (avoid clobbering typing).
    const prefixEl = document.getElementById("kitbot-prefix");
    if (prefixEl && document.activeElement !== prefixEl) {
      prefixEl.value = cfg.prefix ?? "";
      const cd = document.getElementById("kitbot-cooldown");
      if (cd) cd.value = cfg.cooldownMs != null ? String(cfg.cooldownMs / 1000) : "";
      const dist = document.getElementById("kitbot-distance");
      if (dist) dist.value = cfg.maxDistance != null ? String(cfg.maxDistance) : "";
      const ann = document.getElementById("kitbot-announce");
      if (ann) ann.checked = Boolean(cfg.announce);
      const walk = document.getElementById("kitbot-walk");
      if (walk) walk.checked = Boolean(cfg.walkToPlayer);
      const bl = document.getElementById("kitbot-blacklist");
      if (bl && document.activeElement !== bl) bl.value = (cfg.blacklist || []).join(", ");
    }
  } catch {
    /* ignore */
  }
}

function wireKitBotButtons() {
  const out = document.getElementById("kitbot-output");
  const setOut = (text) => {
    if (out) out.textContent = text;
  };
  const run = (action, extra) =>
    rpc(action, extra)
      .then((body) => {
        if (!body.ok) setOut(`error: ${body.error || "request failed"}`);
        else if (body.data?.result) setOut(body.data.result);
        return refreshKitBot();
      })
      .catch((e) => setOut(`error: ${e?.message || e}`));

  document.getElementById("kitbot-start")?.addEventListener("click", () => {
    const prefix = document.getElementById("kitbot-prefix")?.value || undefined;
    void run("kitBotStart", { kitConfig: prefix ? { prefix } : undefined });
  });
  document.getElementById("kitbot-stop")?.addEventListener("click", () => void run("kitBotStop"));
  document.getElementById("kitbot-status")?.addEventListener("click", () => void refreshKitBot());
  document.getElementById("kitbot-reset")?.addEventListener("click", () => void run("kitBotResetCooldowns"));
  document.getElementById("kitbot-stock")?.addEventListener("click", async () => {
    setOut("…");
    try {
      const body = await rpc("kitBotStock", {});
      setOut(body.ok ? body.data?.stock || "no stock" : `error: ${body.error}`);
    } catch (e) {
      setOut(`error: ${e?.message || e}`);
    }
  });

  document.getElementById("kitbot-save")?.addEventListener("click", () => {
    const kitConfig = {
      prefix: document.getElementById("kitbot-prefix")?.value || "!",
      cooldownMs: Math.max(0, Number(document.getElementById("kitbot-cooldown")?.value || 0)) * 1000,
      maxDistance: Math.max(0, Number(document.getElementById("kitbot-distance")?.value || 0)),
      announce: Boolean(document.getElementById("kitbot-announce")?.checked),
      walkToPlayer: Boolean(document.getElementById("kitbot-walk")?.checked),
      blacklist: (document.getElementById("kitbot-blacklist")?.value || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
    void run("kitBotConfig", { kitConfig });
  });

  document.getElementById("kitbot-give")?.addEventListener("click", async () => {
    const username = document.getElementById("kitbot-give-player")?.value || "";
    const kit = document.getElementById("kitbot-give-kit")?.value || undefined;
    if (!username) {
      setOut("Enter a player name.");
      return;
    }
    setOut("…");
    try {
      const body = await rpc("kitBotServe", { username, kit });
      setOut(body.ok ? body.data?.result || "served" : `error: ${body.error}`);
      void refreshKitBot();
    } catch (e) {
      setOut(`error: ${e?.message || e}`);
    }
  });
}
wireKitBotButtons();

document.getElementById("detect-clear")?.addEventListener("click", () => {
  detectionEvents.length = 0;
  detectionSeenIds.clear();
  detectionCleared = true;
  renderDetectionLog();
  void rpc("clearDetection", {}).catch(() => {});
});

/** Keep fixed top bar from covering page content (height can change with vitals wrap). */
function syncTopStickyHeight() {
  const bar = document.getElementById("top-sticky");
  if (!bar) return;
  const h = Math.ceil(bar.getBoundingClientRect().height);
  document.documentElement.style.setProperty("--top-sticky-h", `${h}px`);
}
function initTopStickyHeight() {
  syncTopStickyHeight();
  const bar = document.getElementById("top-sticky");
  if (bar && typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => syncTopStickyHeight());
    ro.observe(bar);
  }
  window.addEventListener("resize", () => syncTopStickyHeight(), { passive: true });
  window.addEventListener("orientationchange", () => setTimeout(syncTopStickyHeight, 150));
}
initTopStickyHeight();

connectEvents();
void refresh({ force: true });
applyView3dState();
void refreshVoxels();
void refreshDetection();
setInterval(() => {
  if (document.hidden) return;
  if (activeDashboardTab() === "detect") void refreshDetection();
  if (activeDashboardTab() === "hunt") void refreshHunt();
  if (activeDashboardTab() === "kitbot") void refreshKitBot();
}, 5000);

// Status HTTP backup — WS already streams status. Keep this slow on mobile.
setInterval(() => {
  if (document.hidden) return;
  void refresh();
}, 4000);

// Adaptive voxel poll only when 3D is enabled + bot live
// While the user is actively steering, refresh much more often so the world keeps up
let lastVoxelPoll = 0;
setInterval(() => {
  if (document.hidden) return;
  if (!isView3dPrefEnabled() || !isBotLiveForView()) return;
  const steering = Boolean(window.__fractalControlsActive);
  let gap;
  if (steering) gap = getView3dQuality() === "full" ? 900 : 1400;
  else gap = getView3dQuality() === "full" ? 3000 : 6000;
  const now = Date.now();
  if (now - lastVoxelPoll < gap) return;
  lastVoxelPoll = now;
  void refreshVoxels();
}, 400);

// Pause work when the tab is backgrounded (saves radio + battery)
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh({ force: true });
});

// 3D on/off — toolbar + always-visible section head (works while collapsed)
function bindView3dToggle(id, on) {
  document.getElementById(id)?.addEventListener("click", () => {
    setView3dPref(on);
    if (on) void refreshVoxels();
  });
}
bindView3dToggle("survey-3d-on", true);
bindView3dToggle("survey-3d-off", false);

// 3D quality (lite / full) — same toolbar
document.getElementById("view3d-quality-lite")?.addEventListener("click", () => {
  setView3dQuality("lite");
});
document.getElementById("view3d-quality-full")?.addEventListener("click", () => {
  setView3dQuality("full");
});
// Sync button state from stored preference on load
(() => {
  const q = getView3dQuality();
  const liteBtn = document.getElementById("view3d-quality-lite");
  const fullBtn = document.getElementById("view3d-quality-full");
  if (liteBtn) liteBtn.classList.toggle("on", q === "lite");
  if (fullBtn) fullBtn.classList.toggle("on", q === "full");
})();

/* —— Chat on/off (hide log + input completely; keep section head) —— */
const CHAT_PREF_KEY = "fractal.chatEnabled";

function isChatPrefEnabled() {
  try {
    const v = localStorage.getItem(CHAT_PREF_KEY);
    if (v === null) return true;
    return v === "1" || v === "true";
  } catch {
    return true;
  }
}

function applyChatPref() {
  const on = isChatPrefEnabled();
  for (const block of document.querySelectorAll(".wire-block")) {
    block.classList.toggle("chat-off", !on);
  }
  const onBtn = document.getElementById("chat-on");
  const offBtn = document.getElementById("chat-off");
  if (onBtn) onBtn.classList.toggle("on", on);
  if (offBtn) offBtn.classList.toggle("on", !on);
}

function setChatPref(on) {
  try {
    localStorage.setItem(CHAT_PREF_KEY, on ? "1" : "0");
  } catch {
    /* private mode */
  }
  applyChatPref();
}

document.getElementById("chat-on")?.addEventListener("click", () => setChatPref(true));
document.getElementById("chat-off")?.addEventListener("click", () => setChatPref(false));
applyChatPref();

/* —— Independent collapse per home section (persisted) —— */
const COLLAPSE_PREF_KEY = "fractal.sectionCollapse";

function loadCollapseMap() {
  try {
    const raw = localStorage.getItem(COLLAPSE_PREF_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveCollapseMap(map) {
  try {
    localStorage.setItem(COLLAPSE_PREF_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

function setSectionCollapsed(block, collapsed) {
  block.classList.toggle("is-collapsed", collapsed);
  const btn = block.querySelector(":scope > .collapse-head > .collapse-toggle");
  if (btn) {
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    btn.title = collapsed ? "Expand section" : "Collapse section";
  }
}

function initCollapsibleSections() {
  const map = loadCollapseMap();
  for (const block of document.querySelectorAll(".collapsible[data-collapse-key]")) {
    const key = block.getAttribute("data-collapse-key");
    if (!key) continue;
    if (map[key]) setSectionCollapsed(block, true);
    const head = block.querySelector(":scope > .collapse-head");
    const toggle = head?.querySelector?.(".collapse-toggle");
    if (!toggle || toggle.dataset.bound) continue;
    toggle.dataset.bound = "1";
    const onToggle = (e) => {
      // Don't collapse when clicking module toggles / close buttons inside the head
      if (e.target.closest(".module-toggle-row, .btn-quiet, a, input, select, label")) return;
      if (e.target !== toggle && !toggle.contains(e.target) && e.currentTarget === head) {
        // Allow clicking the head row (except interactive controls) to toggle
      }
      const next = !block.classList.contains("is-collapsed");
      setSectionCollapsed(block, next);
      const m = loadCollapseMap();
      if (next) m[key] = true;
      else delete m[key];
      saveCollapseMap(m);
    };
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      onToggle(e);
    });
    head?.addEventListener("click", (e) => {
      if (e.target.closest(".module-toggle-row, .btn-quiet, a, input, select, label, button:not(.collapse-toggle)")) {
        return;
      }
      if (e.target === toggle || toggle.contains(e.target)) return;
      onToggle(e);
    });
  }
}
initCollapsibleSections();

// Notifications + service worker (captcha alerts on phone / background tab)
updateNotifyChip();
void registerServiceWorker().then(() => updateNotifyChip());
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "captcha-focus" && event.data.link) {
      // User tapped the notification — keep dashboard focused; link already optional
    }
  });
}
// If permission already granted and user has not opted out, keep chip green
if (notificationPermission() === "granted" && notifyPrefEnabled()) {
  updateNotifyChip();
}

window.addEventListener("survey-radius", () => void refreshVoxels());

// Drag-to-look on the 3D stage (follow · 1st / 3rd person)
window.addEventListener("survey-turn", (event) => {
  const yaw = Number(event.detail?.yaw) || 0;
  const pitch = Number(event.detail?.pitch) || 0;
  if (!yaw && !pitch) return;
  void rpc("turn", { yaw, pitch });
  if (keys.forward || keys.back || keys.left || keys.right) {
    void syncBotLookToView();
  }
});

window.addEventListener("survey-goto", async (event) => {
  const { x, y, z } = event.detail || {};
  if (![x, y, z].every(Number.isFinite)) return;
  await rpc("goto", { x, y, z });
});


// —— Process settings (Settings tab) + per-tab profile settings drawer ——
function openTabSettings(kind) {
  const overlay = document.getElementById("tab-settings-overlay");
  if (!overlay) return;
  const title = document.getElementById("tab-settings-title");
  const titles = {
    play: "Connection settings",
    map: "Map settings",
    announce: "Announce settings",
    detect: "Detection settings",
  };
  if (title) title.textContent = titles[kind] || "Settings";
  document.querySelectorAll(".tab-settings-block").forEach((block) => {
    const show = block.getAttribute("data-for") === kind;
    block.hidden = !show;
  });
  // Always refresh fleet first so profile fields (listener, host, …) match disk
  void (async () => {
    try {
      await refreshFleet();
    } catch {
      /* ignore */
    }
    const bot = (fleetState?.bots || []).find((b) => b.id === selectedBotId);
    fillProfileSettingsForm(bot);
  })();
  // Show save only for play/map/detect (announce uses its own save)
  const saveBtn = document.getElementById("settings-save");
  if (saveBtn) saveBtn.hidden = kind === "announce";
  overlay.hidden = false;
}

function closeTabSettings() {
  const overlay = document.getElementById("tab-settings-overlay");
  if (overlay) overlay.hidden = true;
}

document.querySelectorAll("[data-open-settings]").forEach((btn) => {
  btn.addEventListener("click", () => openTabSettings(btn.getAttribute("data-open-settings")));
});
document.getElementById("tab-settings-close")?.addEventListener("click", () => closeTabSettings());
document.getElementById("tab-settings-close-bottom")?.addEventListener("click", () => closeTabSettings());
document.getElementById("tab-settings-overlay")?.addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeTabSettings();
});

async function loadSettingsForm(attempt = 0) {
  const form = document.getElementById("settings-form");
  const pathEl = document.getElementById("settings-path");
  const msg = document.getElementById("settings-msg-global");
  if (!form) return;
  if (msg) msg.hidden = true;
  let body;
  try {
    body = await rpc("getSettings", {});
  } catch (err) {
    body = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!body.ok || !body.data) {
    // Control API may not be up yet after restart — retry quietly
    if (attempt < 40) {
      setTimeout(() => void loadSettingsForm(attempt + 1), 500);
      return;
    }
    if (msg) {
      msg.hidden = false;
      msg.className = "settings-msg err";
      msg.textContent = body.error || "failed to load settings";
    }
    return;
  }
  const { path: storePath, folder, fields } = body.data;
  if (pathEl) pathEl.textContent = storePath || folder || "Settings/settings.json";
  form.replaceChildren();
  const groups = new Map();
  // Defaults (MC_HOST/MC_HOSTS/MC_PORT/MC_VERSION) live under Connection — skip here to avoid duplicates
  for (const f of fields || []) {
    if (f.group === "Defaults") continue;
    if (!groups.has(f.group)) groups.set(f.group, []);
    groups.get(f.group).push(f);
  }
  for (const [group, list] of groups) {
    const box = document.createElement("details");
    box.className = "settings-group";
    box.open = true;
    const sum = document.createElement("summary");
    sum.textContent = group;
    box.append(sum);
    for (const f of list) {
      const row = document.createElement("div");
      row.className = "settings-row";
      const lab = document.createElement("label");
      lab.htmlFor = `set-${f.key}`;
      lab.textContent = f.label;
      if (f.restart) {
        const tag = document.createElement("span");
        tag.className = "restart-tag";
        tag.textContent = "restart";
        lab.append(tag);
      }
      let input;
      if (f.type === "select") {
        input = document.createElement("select");
        for (const opt of f.options || []) {
          const o = document.createElement("option");
          o.value = opt;
          o.textContent = opt;
          if (String(f.value || "") === opt) o.selected = true;
          input.append(o);
        }
      } else if (f.type === "boolean") {
        input = document.createElement("select");
        for (const [v, t] of [["1", "yes"], ["0", "no"]]) {
          const o = document.createElement("option");
          o.value = v;
          o.textContent = t;
          input.append(o);
        }
        input.value = f.value === "1" ? "1" : "0";
      } else {
        input = document.createElement("input");
        input.type = f.type === "password" ? "password" : f.type === "number" ? "number" : "text";
        input.value = f.value || "";
        if (f.secret && f.hasSecret) input.placeholder = "(unchanged — type to replace)";
        if (f.type === "number") input.step = "any";
      }
      input.id = `set-${f.key}`;
      input.name = f.key;
      input.dataset.key = f.key;
      row.append(lab, input);
      if (f.help) {
        const help = document.createElement("p");
        help.className = "help";
        help.textContent = f.help;
        row.append(help);
      }
      box.append(row);
    }
    form.append(box);
  }
}

async function saveSettingsForm() {
  const form = document.getElementById("settings-form");
  const msg = document.getElementById("settings-msg-global");
  if (!form) return;
  const values = {};
  form.querySelectorAll("[data-key]").forEach((el) => {
    values[el.dataset.key] = el.value;
  });
  const body = await rpc("saveSettings", { values });
  if (msg) {
    msg.hidden = false;
    if (!body.ok) {
      msg.className = "settings-msg err";
      msg.textContent = body.error || "save failed";
      return;
    }
    const d = body.data || {};
    msg.className = "settings-msg ok";
    let text = `Saved ${(d.saved || []).length} process setting(s)`;
    if (d.restartRequired) text += ` · restart: ${(d.restartKeys || []).join(", ")}`;
    msg.textContent = text;
    push("sys", text);
  }
  await loadSettingsForm();
}

document.getElementById("settings-reload")?.addEventListener("click", () => void loadSettingsForm());
document.getElementById("settings-save-global")?.addEventListener("click", () => void saveSettingsForm());
void loadSettingsForm();

// —— Fleet / Profiles (unified) ——
function shortId(id) {
  return String(id || "").slice(0, 8);
}

function phaseToneForBot(bot) {
  if (!bot) return "neutral";
  const phase = bot.bot?.phase || (bot.running ? "running" : "stopped");
  if (phase === "in_game") return "live";
  if (phase === "running" || phase === "connecting" || phase === "reconnecting") return "warn";
  if (bot.bot?.lastKickKind === "captcha" || bot.bot?.lastError) return "fail";
  return "neutral";
}

function updateProfileSelectorUI() {
  const labelEl = document.getElementById("ps-label");
  const metaEl = document.getElementById("ps-meta");
  const dotEl = document.getElementById("ps-status-dot");
  const activeLabel = document.getElementById("active-bot-label");
  const bots = fleetState?.bots || [];
  const bot = bots.find((b) => b.id === selectedBotId) || null;

  if (!bot) {
    if (labelEl) labelEl.textContent = "No profile";
    if (metaEl) metaEl.textContent = bots.length ? "Select a profile" : "Add a profile in Fleet";
    if (dotEl) dotEl.dataset.tone = "neutral";
    if (activeLabel) activeLabel.textContent = "no profile selected";
    return;
  }

  const name = bot.label || bot.username || shortId(bot.id);
  const phase = bot.bot?.phase || (bot.running ? "running" : "stopped");
  const summary = bot.featuresSummary || phase;
  if (labelEl) labelEl.textContent = name;
  if (metaEl) metaEl.textContent = `${phase} · ${summary}`;
  if (dotEl) dotEl.dataset.tone = phaseToneForBot(bot);
  if (activeLabel) activeLabel.textContent = `(${name})`;
}

function renderProfileDropdown() {
  const list = document.getElementById("pd-list");
  const empty = document.getElementById("pd-empty");
  if (!list) return;
  list.replaceChildren();
  const bots = fleetState?.bots || [];
  if (empty) empty.hidden = bots.length > 0;
  for (const b of bots) {
    const row = document.createElement("div");
    row.className = "pd-row" + (b.id === selectedBotId ? " active" : "");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pd-item" + (b.id === selectedBotId ? " active" : "");
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", b.id === selectedBotId ? "true" : "false");
    btn.dataset.select = b.id;
    const phase = b.bot?.phase || (b.running ? "running" : "stopped");
    const tone = phaseToneForBot(b);
    btn.innerHTML = `
      <span class="pd-dot" data-tone="${tone}"></span>
      <span class="pd-text">
        <span class="pd-name">${escapeHtml(b.label || b.username)}</span>
        <span class="pd-sub">${escapeHtml(b.username)} · ${escapeHtml(phase)}</span>
      </span>`;
    const open = document.createElement("a");
    open.className = "pd-open-tab";
    open.href = profileTabUrl(b.id);
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.title = "Open this profile in a new tab";
    open.textContent = "↗";
    open.addEventListener("click", (e) => e.stopPropagation());
    row.append(btn, open);
    list.append(row);
  }
}

function closeProfileDropdown() {
  const dd = document.getElementById("profile-dropdown");
  const btn = document.getElementById("profile-selector-btn");
  if (dd) dd.hidden = true;
  if (btn) btn.setAttribute("aria-expanded", "false");
}

function openProfileDropdown() {
  const dd = document.getElementById("profile-dropdown");
  const btn = document.getElementById("profile-selector-btn");
  if (dd) dd.hidden = false;
  if (btn) btn.setAttribute("aria-expanded", "true");
  renderProfileDropdown();
}

function toggleProfileDropdown() {
  const dd = document.getElementById("profile-dropdown");
  if (!dd) return;
  if (dd.hidden) openProfileDropdown();
  else closeProfileDropdown();
}

function setSelectedBot(id, opts = {}) {
  selectedBotId = id || "";
  try {
    if (id) sessionStorage.setItem("fractal-bot-id", id);
    else sessionStorage.removeItem("fractal-bot-id");
  } catch {
    /* ignore */
  }
  if (opts.updateUrl !== false) writeProfileIdToUrl(id);
  const bot = (fleetState?.bots || []).find((b) => b.id === id) || null;
  renderFleet();
  fillProfileEditor(bot, true);
  fillTasksForm(bot);
  updateProfileSelectorUI();
  renderProfileDropdown();
  // Chat/wire is per profile — show this profile's log and tabs
  hideTpaBanner();
  renderWireTabs();
  renderActiveWireLog();
  // Reload this profile's homes for /home autocomplete (never mix accounts)
  void seedHomesForSelectedProfile();
  // Instantly refresh status/data for the new profile context
  void refresh();
}

async function refreshFleet() {
  const body = await rpc("fleetStatus", {});
  if (body.ok && body.data) {
    fleetState = body.data;
    if (!selectedBotId && body.data.bots?.length) {
      const fromUrl = readProfileIdFromUrl();
      if (fromUrl && body.data.bots.some((b) => b.id === fromUrl)) {
        setSelectedBot(fromUrl, { updateUrl: false });
        return;
      }
      const running = body.data.bots.find((b) => b.running);
      setSelectedBot((running || body.data.bots[0]).id);
      return;
    }
    // If previously selected id is gone, clear or pick another
    if (selectedBotId && !(body.data.bots || []).some((b) => b.id === selectedBotId)) {
      const next = body.data.bots?.[0];
      setSelectedBot(next ? next.id : "");
      return;
    }
    if (selectedBotId && !readProfileIdFromUrl()) {
      writeProfileIdToUrl(selectedBotId);
    }
    renderFleet();
    updateProfileSelectorUI();
    renderProfileDropdown();
  }
}

function featChecked(f, key) {
  return f && f[key] ? "checked" : "";
}

function renderFleet() {
  const grid = document.getElementById("fleet-grid");
  const pathEl = document.getElementById("fleet-path");
  if (!grid || !fleetState) return;
  if (pathEl) pathEl.textContent = fleetState.accountsPath || "accounts.json";
  const ann = document.getElementById("announce-json");
  if (ann && fleetState.defaultAnnouncements && !ann.dataset.touched) {
    ann.value = JSON.stringify(fleetState.defaultAnnouncements, null, 0);
  }
  grid.replaceChildren();
  const bots = fleetState.bots || [];
  if (!bots.length) {
    const empty = document.createElement("article");
    empty.className = "profile-card empty";
    empty.innerHTML =
      "<strong>No profiles yet</strong><p class='meta-line'>Create a profile below, then configure its tasks on the Tasks tab.</p>";
    grid.append(empty);
    fillProfileEditor(null);
    fillTasksForm(null);
    updateProfileSelectorUI();
    return;
  }
  for (const b of bots) {
    const card = document.createElement("article");
    const phase = b.bot?.phase || (b.running ? "running" : "stopped");
    const world = b.bot?.worldKind || "—";
    const pos = b.bot?.position
      ? `${Math.round(b.bot.position.x)} ${Math.round(b.bot.position.y)} ${Math.round(b.bot.position.z)}`
      : "—";
    const summary = b.featuresSummary || "—";
    const selected = b.id === selectedBotId;
    const noPw = b.auth !== "microsoft" && !b.hasPassword;
    card.className =
      "profile-card" +
      (selected ? " selected" : "") +
      (b.running ? " running" : "") +
      (noPw ? " warn" : "");
    card.innerHTML = `
      <button type="button" class="profile-card-main" data-select="${b.id}">
        <span class="profile-card-title">${escapeHtml(b.label || b.username)}</span>
        <span class="profile-card-meta">${escapeHtml(b.username)}${noPw ? " · <em>no password</em>" : ""}</span>
        <span class="profile-card-state">${escapeHtml(phase)} · ${escapeHtml(summary)}</span>
        <span class="profile-card-pos">${escapeHtml(world)} · ${pos}</span>
      </button>
      <div class="profile-card-actions">
        <button type="button" data-start="${b.id}" ${noPw ? "title=\"Set a password before starting\"" : ""}>Start</button>
        <button type="button" data-stop="${b.id}">Stop</button>
        <a class="profile-open-tab" href="${profileTabUrl(b.id)}" target="_blank" rel="noopener noreferrer" title="Open in new tab">↗</a>
      </div>`;
    grid.append(card);
  }
  fillProfileEditor(bots.find((b) => b.id === selectedBotId) || null);
  fillTasksForm(bots.find((b) => b.id === selectedBotId) || null);
  updateProfileSelectorUI();
}

function fillProfileEditor(bot, force = false) {
  const editor = document.getElementById("profile-editor");
  const form = document.getElementById("profile-form");
  if (!editor || !form) return;
  if (!bot) {
    editor.hidden = true;
    profileFormDirty = false;
    profileFormDirtyUntil = 0;
    return;
  }
  editor.hidden = false;
  const title = document.getElementById("profile-title");
  if (title) title.textContent = bot.label || bot.username;

  const switched = form.id.value && form.id.value !== bot.id;
  // Don't clobber fields while the user is typing (same profile)
  if (!force && !switched && (profileFormDirty || Date.now() < profileFormDirtyUntil)) {
    return;
  }

  profileFormDirty = false;
  profileFormDirtyUntil = 0;
  form.id.value = bot.id;
  form.label.value = bot.label || "";
  form.username.value = bot.username || "";
  form.password.value = "";
  const pw = form.password;
  if (pw) {
    pw.placeholder = bot.hasPassword ? "•••••••• (leave blank to keep)" : "Password required to start";
  }
  form.auth.value = bot.auth || "offline";
  form.host.value = bot.host || "";
  form.port.value = bot.port != null ? bot.port : "";
  form.notes.value = bot.notes || "";

  const msBtn = document.getElementById("profile-ms-auth");
  if (msBtn) {
    msBtn.hidden = (bot.auth || "offline") !== "microsoft";
  }
  // Keep banner if this profile already has a live device code
  const msa = bot.bot?.msaCode;
  if (msa && msa.user_code) {
    showMsaCodeBanner(msa);
  } else if ((bot.auth || "offline") !== "microsoft") {
    hideMsaCodeBanner();
  }
}

let tasksApplying = false;
let tasksDirtyUntil = 0;
/** Per-profile pending feature patches — concurrent toggles merge instead of dropping. */
const featurePatchQueue = new Map();
let featurePatchRunning = false;
let profileFormDirty = false;
let profileFormDirtyUntil = 0;

function fillTasksForm(bot) {
  syncFeatureSwitches(bot);
}

function syncFeatureSwitches(bot) {
  // Never clobber UI while the user is flipping switches or a save is in flight
  if (tasksApplying || featurePatchRunning || Date.now() < tasksDirtyUntil) return;
  const f = (bot && bot.features) || {};
  const setToggle = (name, on) => {
    document.querySelectorAll(`[data-feat="${name}"]`).forEach((wrap) => {
      const input = wrap.querySelector('input[type="checkbox"]');
      // Don't fight a switch the user just touched
      if (input && input.dataset.userTouched === "1") return;
      if (input) input.checked = !!on;
      wrap.classList.toggle("on", !!on);
    });
    const legacy = document.querySelector(`#tasks-form [name="${name}"]`);
    if (legacy) legacy.checked = !!on;
  };
  setToggle("online", f.online);
  setToggle("announcements", f.announcements);
  setToggle("antiAfk", f.antiAfk);
  setToggle("hunt", f.hunt);
  setToggle("map", f.map);
  const mode = f.mapMode || "box";
  const sel = document.getElementById("map-mode-select");
  if (sel && !sel.matches(":focus")) sel.value = mode;
  const legacyMode = document.querySelector("#tasks-form [name=mapMode]");
  if (legacyMode) legacyMode.value = mode;
  const annFor = document.getElementById("announce-for");
  if (annFor) {
    annFor.textContent = bot ? `Modules for ${bot.label || bot.username}` : "Select a profile first";
  }
  const mapFor = document.getElementById("map-for");
  if (mapFor) {
    mapFor.textContent = bot ? `Map module · ${bot.label || bot.username}` : "Select a profile first";
  }
  const detectFor = document.getElementById("detect-for");
  if (detectFor) {
    detectFor.textContent = bot ? `Detect module · ${bot.label || bot.username}` : "Select a profile first";
  }
  const playFor = document.getElementById("play-for");
  if (playFor) {
    playFor.textContent = bot ? `Play module · ${bot.label || bot.username}` : "Select a profile first";
  }
  // Always rebind announce messages to the selected profile (unless user is editing)
  const ann = document.getElementById("announce-json");
  if (ann) {
    if (!bot) {
      ann.value = "";
      delete ann.dataset.touched;
    } else if (!ann.dataset.touched) {
      const msgs = Array.isArray(bot.announcementMessages) && bot.announcementMessages.length
        ? bot.announcementMessages
        : (fleetState?.defaultAnnouncements || []);
      ann.value = JSON.stringify(msgs, null, 2);
    }
  }
  fillProfileSettingsForm(bot);
}

/**
 * Apply feature flags for a specific profile id.
 * Concurrent toggles (Online + Anti-AFK + Map…) merge into one save per profile
 * so no switch is dropped and profiles never overwrite each other.
 */
async function applyFeaturePatch(botId, partial) {
  if (!botId || !partial || typeof partial !== "object") return;
  const prev = featurePatchQueue.get(botId) || {};
  featurePatchQueue.set(botId, { ...prev, ...partial });

  // Optimistic local state so UI + other profiles stay correct during the RPC
  const bot = (fleetState?.bots || []).find((b) => b.id === botId);
  if (bot) {
    bot.features = { ...(bot.features || {}), ...partial };
    bot.featuresSummary = undefined;
  }

  tasksDirtyUntil = Date.now() + 3000;
  if (featurePatchRunning) return;

  featurePatchRunning = true;
  tasksApplying = true;
  try {
    while (featurePatchQueue.size) {
      const [id, patch] = featurePatchQueue.entries().next().value;
      featurePatchQueue.delete(id);
      const body = await rpc("fleetSetFeatures", { id, features: patch });
      if (body.ok) {
        logActivity(body.data?.result || "features updated");
        const b = (fleetState?.bots || []).find((x) => x.id === id);
        if (b) b.features = { ...(b.features || {}), ...patch };
      } else {
        push("err", body.error || "feature update failed");
      }
    }
    await refreshFleet();
  } finally {
    featurePatchRunning = false;
    tasksApplying = false;
    tasksDirtyUntil = Date.now() + 900;
    // Clear touch locks after server state is back
    document.querySelectorAll("[data-feat] input[type=checkbox]").forEach((inp) => {
      delete inp.dataset.userTouched;
    });
  }
}


function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

document.getElementById("fleet-grid")?.addEventListener("click", async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.dataset.select) {
    setSelectedBot(t.dataset.select);
    await refresh();
    return;
  }
  if (t.dataset.start) {
    const body = await rpc("fleetStart", { id: t.dataset.start });
    if (!body.ok) push("err", body.error || "start failed");
    else {
      setSelectedBot(t.dataset.start);
      push("sys", body.data?.result || "started");
    }
    await refreshFleet();
    await refresh();
    return;
  }
  if (t.dataset.stop) {
    const body = await rpc("fleetStop", { id: t.dataset.stop });
    if (!body.ok) push("err", body.error || "stop failed");
    else push("sys", body.data?.result || "stopped");
    await refreshFleet();
    await refresh();
    return;
  }
  if (t.dataset.remove) {
    if (!confirm("Remove this account from the fleet?")) return;
    await rpc("fleetRemoveAccount", { id: t.dataset.remove });
    await refreshFleet();
    return;
  }
  if (t.dataset.applyFeats) {
    const id = t.dataset.applyFeats;
    const box = document.querySelector(`[data-feats-for="${id}"]`);
    const features = {};
    box?.querySelectorAll("input[data-feat]").forEach((inp) => {
      features[inp.getAttribute("data-feat")] = inp.checked;
    });
    if (features.map) features.mapMode = "box";
    const body = await rpc("fleetSetFeatures", { id, features });
    logActivity(body.data?.result || `features ${id}`);
    await refreshFleet();
  }
});

document.getElementById("fleet-start-all")?.addEventListener("click", async () => {
  await rpc("fleetStartAll", {});
  logActivity("fleet start all");
  await refreshFleet();
});
document.getElementById("fleet-stop-all")?.addEventListener("click", async () => {
  await rpc("fleetStopAll", {});
  logActivity("fleet stop all");
  await refreshFleet();
});
document.getElementById("fleet-refresh")?.addEventListener("click", () => void refreshFleet());

document.getElementById("fleet-add")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  // New profiles start offline — user enables Online (or Start) when ready
  const features = {
    online: false,
    announcements: false,
    antiAfk: false,
    hunt: false,
    map: false,
    mapMode: "box",
  };
  const authMode = String(fd.get("auth") || "offline") === "microsoft" ? "microsoft" : "offline";
  const body = await rpc("fleetAddAccount", {
    account: {
      label: String(fd.get("label") || ""),
      username: String(fd.get("username") || ""),
      password: String(fd.get("password") || ""),
      features,
      enabled: false,
      auth: authMode,
    },
  });
  e.target.reset();
  logActivity(`added ${fd.get("username")} (${authMode})`);
  await refreshFleet();
  if (body.ok && body.data?.id) setSelectedBot(body.data.id);
});

document.getElementById("announce-json")?.addEventListener("input", (e) => {
  e.target.dataset.touched = "1";
});
document.getElementById("announce-save")?.addEventListener("click", async () => {
  const ta = document.getElementById("announce-json");
  if (!selectedBotId) {
    push("err", "Select a profile first");
    return;
  }
  try {
    const announcements = JSON.parse(ta.value || "[]");
    const bot = (fleetState?.bots || []).find((b) => b.id === selectedBotId);
    if (!bot) {
      push("err", "Profile not found");
      return;
    }
    const body = await rpc("fleetAddAccount", {
      account: {
        id: selectedBotId,
        username: bot.username,
        announcementMessages: announcements,
      },
    });
    if (body.ok) {
      ta.dataset.touched = "";
      logActivity("saved profile announcements");
      push("sys", "Announce messages saved for profile");
      // Ensure announce feature can run with new messages
      await refreshFleet();
    } else {
      push("err", body.error || "save failed");
    }
  } catch (err) {
    push("err", `Invalid JSON: ${err.message || err}`);
  }
});


// Don't let fleet refresh wipe in-progress edits
document.getElementById("profile-form")?.addEventListener("input", () => {
  profileFormDirty = true;
  profileFormDirtyUntil = Date.now() + 60_000;
});
document.getElementById("profile-form")?.addEventListener("change", (e) => {
  profileFormDirty = true;
  profileFormDirtyUntil = Date.now() + 60_000;
  if (e.target && e.target.name === "auth") {
    const msBtn = document.getElementById("profile-ms-auth");
    if (msBtn) msBtn.hidden = e.target.value !== "microsoft";
    if (e.target.value !== "microsoft") hideMsaCodeBanner();
  }
});

document.getElementById("profile-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const id = form.id.value;
  if (!id) return;
  const num = (v) => (v === "" || v == null ? undefined : Number(v));
  const account = {
    id,
    username: form.username.value.trim(),
    label: form.label.value.trim() || undefined,
    auth: form.auth.value,
    host: form.host.value.trim() || undefined,
    port: num(form.port.value),
    notes: form.notes.value.trim() || undefined,
  };
  if (form.password.value) account.password = form.password.value;
  const body = await rpc("fleetAddAccount", { account });
  if (body.ok) {
    push("sys", `Saved profile ${account.username}`);
    logActivity(`profile saved ${account.username}`);
    profileFormDirty = false;
    profileFormDirtyUntil = 0;
    if (body.data?.id) setSelectedBot(body.data.id);
  } else {
    push("err", body.error || "save failed");
  }
  await refreshFleet();
});

document.getElementById("profile-remove")?.addEventListener("click", async () => {
  const id = document.getElementById("profile-form")?.id?.value;
  if (!id) return;
  if (!confirm("Remove this profile?")) return;
  await rpc("fleetRemoveAccount", { id });
  if (selectedBotId === id) setSelectedBot("");
  await refreshFleet();
});

// Feature switches (Online, Map, Announce, Anti-AFK, …) — each switch is independent
document.addEventListener("change", (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const wrap = t.closest("[data-feat]");
  if (wrap && t.matches('input[type="checkbox"]')) {
    if (!selectedBotId) {
      push("err", "Select a profile first");
      t.checked = !t.checked;
      return;
    }
    // Capture profile at click time so a mid-flight profile switch cannot steal the patch
    const botId = selectedBotId;
    const feat = wrap.getAttribute("data-feat");
    if (!feat) return;
    t.dataset.userTouched = "1";
    wrap.classList.toggle("on", t.checked);
    tasksDirtyUntil = Date.now() + 3000;
    const patch = { [feat]: t.checked };
    if (feat === "map") {
      const mode = document.getElementById("map-mode-select")?.value || "box";
      patch.mapMode = mode;
    }
    void (async () => {
      await applyFeaturePatch(botId, patch);
      // Online includes auto-reconnect; never clear auto-lobby preference
      if (feat === "online") {
        const lobbyEl = document.getElementById("toggle-lobby");
        const lobbyOn = lobbyEl ? Boolean(lobbyEl.checked) : true;
        await rpc("set", {
          autoReconnect: t.checked,
          autoLobby: lobbyOn,
        }).catch(() => {});
        if (!t.checked) applyView3dState();
        await refresh();
        applyView3dState();
        // Load process + profile settings for the active profile (no manual reload)
        void loadSettingsForm(0);
        const bot = (fleetState?.bots || []).find((b) => b.id === botId);
        fillProfileSettingsForm(bot);
      }
    })();
    return;
  }
  if (t.id === "map-mode-select") {
    if (!selectedBotId) return;
    const botId = selectedBotId;
    tasksDirtyUntil = Date.now() + 3000;
    const mapOn = document.querySelector('[data-feat="map"] input')?.checked;
    void applyFeaturePatch(botId, { map: !!mapOn, mapMode: t.value || "box" });
  }
});

// Connection flag switches — only change when the user flips them
document.getElementById("toggle-reconnect")?.addEventListener("change", async (e) => {
  const el = e.target;
  const on = el.checked;
  el.dataset.userTouched = "1";
  lockConnectionSwitch("reconnect");
  el.closest(".task-toggle")?.classList.toggle("on", on);
  const botId = selectedBotId;
  await rpc("set", { autoReconnect: on });
  if (botId) {
    const bot = (fleetState?.bots || []).find((b) => b.id === botId);
    if (bot?.username) {
      await rpc("fleetAddAccount", {
        account: {
          id: botId,
          username: bot.username,
          profile: { ...(bot.profile || {}), autoReconnect: on },
        },
      }).catch(() => {});
    }
  }
  await refresh();
  // Keep lock so the refresh response cannot snap the switch back
  lockConnectionSwitch("reconnect");
  el.checked = on;
  el.closest(".task-toggle")?.classList.toggle("on", on);
});
document.getElementById("toggle-lobby")?.addEventListener("change", async (e) => {
  const el = e.target;
  const on = el.checked;
  el.dataset.userTouched = "1";
  lockConnectionSwitch("lobby");
  el.closest(".task-toggle")?.classList.toggle("on", on);
  const botId = selectedBotId;
  await rpc("set", { autoLobby: on });
  if (botId) {
    const bot = (fleetState?.bots || []).find((b) => b.id === botId);
    if (bot?.username) {
      await rpc("fleetAddAccount", {
        account: {
          id: botId,
          username: bot.username,
          profile: { ...(bot.profile || {}), autoLobby: on },
        },
      }).catch(() => {});
    }
  }
  await refresh();
  lockConnectionSwitch("lobby");
  el.checked = on;
  el.closest(".task-toggle")?.classList.toggle("on", on);
});


document.getElementById("profile-start")?.addEventListener("click", async () => {
  const id = document.getElementById("profile-form")?.id?.value;
  if (!id) return;
  const body = await rpc("fleetStart", { id });
  if (!body.ok) push("err", body.error || "start failed");
  else push("sys", body.data?.result || "started");
  setSelectedBot(id);
  await refreshFleet();
  await refresh();
});

document.getElementById("profile-stop")?.addEventListener("click", async () => {
  const id = document.getElementById("profile-form")?.id?.value;
  if (!id) return;
  const body = await rpc("fleetStop", { id });
  if (!body.ok) push("err", body.error || "stop failed");
  else push("sys", body.data?.result || "stopped");
  await refreshFleet();
  await refresh();
});

document.getElementById("profile-ms-auth")?.addEventListener("click", async () => {
  const id = document.getElementById("profile-form")?.id?.value;
  if (!id) return;
  push("sys", "Starting Microsoft device-code auth…");
  const body = await rpc("fleetMicrosoftAuth", { id });
  if (!body.ok) push("err", body.error || "Microsoft auth failed");
  else push("sys", body.data?.result || "auth started");
  await refreshFleet();
  await refresh();
});

document.getElementById("msa-copy")?.addEventListener("click", async () => {
  const el = document.getElementById("msa-user-code");
  const code = el?.textContent?.trim();
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    push("sys", `Copied code ${code}`);
  } catch {
    // Fallback for non-secure contexts
    try {
      const ta = document.createElement("textarea");
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      push("sys", `Copied code ${code}`);
    } catch (e) {
      push("err", "Could not copy code");
    }
  }
});

function showMsaCodeBanner(data) {
  const banner = document.getElementById("msa-code-banner");
  const codeEl = document.getElementById("msa-user-code");
  const link = document.getElementById("msa-open-link");
  const hint = document.getElementById("msa-code-hint");
  if (!banner || !codeEl) return;
  const userCode = String(data?.user_code || "").trim();
  const uri = String(data?.verification_uri || "https://www.microsoft.com/link").trim();
  codeEl.textContent = userCode || "—";
  if (link) {
    link.href = uri;
    link.textContent = "Open login";
  }
  if (hint) {
    const exp =
      typeof data?.expires_in === "number" ? ` · expires in ~${Math.round(data.expires_in / 60)} min` : "";
    hint.textContent = `Enter the code at the Microsoft link${exp}. Tokens are cached under Settings/auth_cache and reused after restart.`;
  }
  banner.hidden = false;
}

function hideMsaCodeBanner() {
  const banner = document.getElementById("msa-code-banner");
  if (banner) banner.hidden = true;
}

setInterval(() => {
  if (document.hidden) return;
  // Fleet list is small but no need to hammer it off the Settings tab
  const tab = activeDashboardTab();
  if (tab !== "settings" && tab !== "play") return;
  void refreshFleet();
}, 8000);
void refreshFleet();

/* —— Profile selector (header) —— */
document.getElementById("profile-selector-btn")?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleProfileDropdown();
});

document.getElementById("pd-list")?.addEventListener("click", async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const item = t.closest("[data-select]");
  if (!item) return;
  const id = item.getAttribute("data-select");
  if (id) {
    setSelectedBot(id);
    closeProfileDropdown();
  }
});

document.getElementById("pd-manage")?.addEventListener("click", (e) => {
  e.stopPropagation();
  closeProfileDropdown();
  openFleetManage();
});

document.getElementById("fleet-back")?.addEventListener("click", () => {
  closeFleetManage();
});

document.addEventListener("click", (e) => {
  const switcher = document.getElementById("profile-switcher");
  if (switcher && !switcher.contains(e.target)) closeProfileDropdown();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeProfileDropdown();
    if (fleetManageOpen) closeFleetManage();
  }
});

/* —— Fleet manage (no tab — opened via Manage) —— */
let fleetManageOpen = false;
let tabBeforeFleet = "play";

/** Module catalog for sidebar + search palette (Play is the home page, not a module). */
const MODULES = [
  {
    id: "map",
    name: "Map",
    desc: "Elytra terrain survey",
    icon: "▣",
    keywords: ["map", "elytra", "terrain", "xaero", "survey", "box", "ring"],
  },
  {
    id: "detect",
    name: "Detect",
    desc: "Players, crystals, combat, alerts",
    icon: "◎",
    keywords: ["detect", "detection", "player", "crystal", "tnt", "combat", "notify", "alert"],
  },
  {
    id: "announce",
    name: "Announce",
    desc: "Timed chat messages",
    icon: "✉",
    keywords: ["announce", "announcement", "chat", "spam", "timed"],
  },
  {
    id: "hunt",
    name: "Hunt",
    desc: "Base hunting, stashes, players",
    icon: "⛏",
    keywords: ["hunt", "base", "stash", "elytra", "player", "explore", "bh", "loot", "database"],
  },
  {
    id: "kitbot",
    name: "Kit Bot",
    desc: "Serve kits on chat",
    icon: "🎁",
    keywords: ["kit", "kitbot", "give", "serve", "drop", "prefix", "handout"],
  },
];
/** Utilities reachable from the top bar (not sidebar modules) */
const UTILITIES = [
  {
    id: "settings",
    name: "Settings",
    desc: "Process / global settings",
    keywords: ["settings", "config", "host", "token", "global"],
  },
  {
    id: "log",
    name: "Log",
    desc: "Activity feed",
    keywords: ["log", "activity", "history", "events"],
  },
];

/** Home page = Play panel (control / inventory / nearby / wire). */
function goHome() {
  activateTab("play");
}

function openFleetManage() {
  const current =
    document.querySelector(".side-nav-item.on")?.getAttribute("data-tab") ||
    document.querySelector(".tab-bar .tab.on")?.getAttribute("data-tab");
  if (current && current !== "fleet") tabBeforeFleet = current;
  fleetManageOpen = true;
  closeSidebar();
  for (const btn of document.querySelectorAll(".side-nav-item")) {
    btn.classList.remove("on");
    btn.removeAttribute("aria-current");
  }
  for (const panel of document.querySelectorAll(".tab-panel")) {
    const isFleet = panel.getAttribute("data-tab") === "fleet";
    panel.classList.toggle("on", isFleet);
    if (isFleet) panel.removeAttribute("hidden");
    else panel.setAttribute("hidden", "");
  }
  try {
    history.replaceState(null, "", "#fleet");
  } catch {
    /* ignore */
  }
}

function closeFleetManage() {
  fleetManageOpen = false;
  activateTab(tabBeforeFleet || "play");
}

/* —— Sidebar modules —— */
function openSidebar() {
  document.body.classList.add("nav-open");
  document.documentElement.classList.add("nav-open");
  const backdrop = document.getElementById("sidebar-backdrop");
  if (backdrop) backdrop.hidden = false;
}

function closeSidebar() {
  document.body.classList.remove("nav-open");
  document.documentElement.classList.remove("nav-open");
  const backdrop = document.getElementById("sidebar-backdrop");
  if (backdrop) backdrop.hidden = true;
}

function toggleSidebar() {
  if (document.body.classList.contains("nav-open")) closeSidebar();
  else openSidebar();
}

function activateTab(name) {
  let tabName = name || "play";
  if (tabName === "profiles" || tabName === "status" || tabName === "tasks" || tabName === "chat") tabName = "play";
  if (tabName === "fleet") {
    openFleetManage();
    return;
  }
  fleetManageOpen = false;
  for (const btn of document.querySelectorAll(".side-nav-item")) {
    const on = btn.getAttribute("data-tab") === tabName;
    btn.classList.toggle("on", on);
    if (on) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  }
  for (const btn of document.querySelectorAll("#nav-settings, #nav-log, #nav-home")) {
    const on = btn.getAttribute("data-tab") === tabName;
    btn.classList.toggle("on", on);
  }
  for (const btn of document.querySelectorAll(".tab-bar .tab")) {
    const on = btn.getAttribute("data-tab") === tabName;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  }
  for (const panel of document.querySelectorAll(".tab-panel")) {
    const on = panel.getAttribute("data-tab") === tabName;
    panel.classList.toggle("on", on);
    if (on) panel.removeAttribute("hidden");
    else panel.setAttribute("hidden", "");
  }
  try {
    history.replaceState(null, "", `#${tabName}`);
  } catch {
    /* ignore */
  }
  closeSidebar();
  placeSurveyMount(tabName);
  if (tabName === "play") {
    requestAnimationFrame(() => window.fractalSurvey?.resize?.());
  }
  if (tabName === "detect") void refreshDetection();
  if (tabName === "hunt") void refreshHunt();
  if (tabName === "kitbot") void refreshKitBot();
  if (tabName === "settings") {
    void loadSettingsForm(0);
    const bot = (fleetState?.bots || []).find((b) => b.id === selectedBotId);
    fillConnectionSettingsForm(bot);
  }
  renderSideNav(document.getElementById("sidebar-search")?.value || "");
}

/** 3D survey lives only on the Play (home) module. */
function placeSurveyMount(tabName) {
  const shared = document.getElementById("survey-shared");
  if (!shared) return;
  const playMount = document.getElementById("survey-mount-play");
  if (playMount) {
    playMount.appendChild(shared);
    shared.hidden = false;
  }
  void tabName;
}

function filterModuleList(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return MODULES.slice();
  return MODULES.filter((m) => {
    if (m.name.toLowerCase().includes(q)) return true;
    if (m.desc.toLowerCase().includes(q)) return true;
    if (m.id.toLowerCase().includes(q)) return true;
    return m.keywords.some((k) => k.includes(q) || q.includes(k));
  });
}

function renderSideNav(query) {
  const nav = document.getElementById("side-nav");
  if (!nav) return;
  const active =
    document.querySelector(".tab-panel.on")?.getAttribute("data-tab") ||
    activeDashboardTab() ||
    "play";
  const hits = filterModuleList(query);
  nav.replaceChildren();
  if (!hits.length) {
    const empty = document.createElement("p");
    empty.className = "sidebar-empty hint";
    empty.textContent = "No modules match";
    nav.append(empty);
    return;
  }
  for (const m of hits) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "side-nav-item" + (m.id === active ? " on" : "");
    btn.setAttribute("data-tab", m.id);
    if (m.id === active) btn.setAttribute("aria-current", "page");
    const icon = document.createElement("span");
    icon.className = "sn-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = m.icon || "•";
    const textWrap = document.createElement("span");
    textWrap.className = "sn-text";
    const strong = document.createElement("strong");
    strong.textContent = m.name;
    const small = document.createElement("small");
    small.textContent = m.desc;
    textWrap.append(strong, small);
    btn.append(icon, textWrap);
    btn.addEventListener("click", () => {
      closeProfileDropdown();
      const search = document.getElementById("sidebar-search");
      if (search) search.value = "";
      activateTab(m.id);
    });
    nav.append(btn);
  }
}

document.querySelectorAll("#nav-settings, #nav-log, #nav-home").forEach((btn) => {
  btn.addEventListener("click", () => {
    closeProfileDropdown();
    closeSidebar();
    const search = document.getElementById("sidebar-search");
    if (search) search.value = "";
    activateTab(btn.getAttribute("data-tab") || "play");
  });
});
document.querySelector(".brand")?.addEventListener("click", (e) => {
  // Brand mark → home (Play)
  e.preventDefault();
  closeProfileDropdown();
  closeSidebar();
  goHome();
});
document.getElementById("nav-toggle")?.addEventListener("click", () => {
  closeProfileDropdown();
  toggleSidebar();
  // Focus search when opening drawer on mobile
  if (document.body.classList.contains("nav-open")) {
    setTimeout(() => document.getElementById("sidebar-search")?.focus(), 50);
  }
});
document.getElementById("sidebar-close")?.addEventListener("click", () => closeSidebar());
document.getElementById("sidebar-backdrop")?.addEventListener("click", () => closeSidebar());

document.getElementById("sidebar-search")?.addEventListener("input", (e) => {
  renderSideNav(e.target.value);
});
document.getElementById("sidebar-search")?.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.target.value = "";
    renderSideNav("");
    e.target.blur();
  }
  if (e.key === "Enter") {
    e.preventDefault();
    const first = document.querySelector("#side-nav .side-nav-item");
    if (first) first.click();
  }
});

renderSideNav("");

const hashTab = (location.hash || "").replace(/^#/, "");
const valid = new Set(["play", "map", "detect", "announce", "hunt", "kitbot", "settings", "log"]);
const legacy = {
  home: "play",
  profiles: "play",
  status: "play",
  tasks: "play",
  chat: "play",
  fleet: "fleet",
};
if (hashTab === "fleet" || legacy[hashTab] === "fleet") {
  openFleetManage();
} else {
  const resolved =
    (legacy[hashTab] && legacy[hashTab] !== "fleet" ? legacy[hashTab] : null) ||
    (valid.has(hashTab) ? hashTab : "play");
  activateTab(resolved);
}


/* goto on map tab (chat lives only on Play) */
document.getElementById("goto-map")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const x = Number(fd.get("x"));
  const y = Number(fd.get("y"));
  const z = Number(fd.get("z"));
  if (![x, y, z].every(Number.isFinite)) {
    push("err", "goto needs numeric x y z");
    return;
  }
  await rpc("goto", { x, y, z });
});


/* —— Per-profile settings (Settings/Profiles/<id>.json) —— */
/** Load process-wide connection defaults (MC_HOST/…) into the Connection form. */
async function fillConnectionDefaultsFromProcess() {
  const form = document.getElementById("connection-settings-form");
  if (!form) return;
  try {
    const body = await rpc("getSettings", {});
    if (!body.ok || !body.data?.fields) return;
    const byKey = new Map((body.data.fields || []).map((f) => [f.key, f]));
    for (const key of ["MC_HOST", "MC_HOSTS", "MC_PORT", "MC_VERSION"]) {
      const el = form.elements?.namedItem?.(key) || form.querySelector(`[name="${key}"]`);
      if (!el || !("value" in el)) continue;
      const f = byKey.get(key);
      el.value = f?.value != null ? String(f.value) : "";
    }
  } catch {
    /* ignore — process API may be down */
  }
}

function fillConnectionSettingsForm(bot) {
  const form = document.getElementById("connection-settings-form");
  const pathEl = document.getElementById("connection-settings-path");
  const hint = document.getElementById("connection-profile-hint");
  if (!form) return;
  void fillConnectionDefaultsFromProcess();
  if (!bot) {
    if (pathEl) pathEl.textContent = "Process defaults · select a profile for per-account overrides";
    if (hint) hint.textContent = "Select a profile in the top bar for profile overrides";
    for (const name of [
      "host",
      "port",
      "version",
      "viewDistance",
      "requiredServerPortals",
      "portalRetryMs",
      "reconnectMs",
      "reconnectMaxMs",
      "rateLimitCooldownMs",
      "captchaCooldownMs",
    ]) {
      const el = form.elements?.namedItem?.(name) || form.querySelector(`[name="${name}"]`);
      if (el && "value" in el) el.value = "";
    }
    return;
  }
  const fileStem = String(bot.label || bot.username || bot.id || "profile")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "profile";
  if (pathEl) {
    pathEl.textContent = `Defaults (process) · Profile ${bot.label || bot.username} · Settings/Profiles/${fileStem}.json`;
  }
  if (hint) hint.textContent = `Overrides for ${bot.label || bot.username} (blank host/port/version = use process default)`;
  const p = bot.profile || {};
  if (form.host) form.host.value = bot.host || "";
  if (form.port) form.port.value = bot.port != null ? bot.port : "";
  if (form.version) form.version.value = p.version || "";
  if (form.viewDistance) form.viewDistance.value = p.viewDistance ?? "";
  if (form.autoLobby) form.autoLobby.value = p.autoLobby === false ? "false" : "true";
  if (form.autoReconnect) form.autoReconnect.value = p.autoReconnect === false ? "false" : "true";
  if (form.requiredServerPortals) form.requiredServerPortals.value = p.requiredServerPortals ?? "";
  if (form.portalRetryMs) form.portalRetryMs.value = p.portalRetryMs ?? "";
  if (form.reconnectMs) form.reconnectMs.value = p.reconnectMs ?? "";
  if (form.reconnectMaxMs) form.reconnectMaxMs.value = p.reconnectMaxMs ?? "";
  if (form.rateLimitCooldownMs) form.rateLimitCooldownMs.value = p.rateLimitCooldownMs ?? "";
  if (form.captchaCooldownMs) form.captchaCooldownMs.value = p.captchaCooldownMs ?? "";
}

async function saveConnectionSettings() {
  const form = document.getElementById("connection-settings-form");
  const msg = document.getElementById("settings-msg-connection");
  if (!form) return;
  const num = (v) => (v === "" || v == null ? undefined : Number(v));
  const boolSel = (v) => (v === "true" ? true : v === "false" ? false : undefined);

  // Always save process-wide defaults (no profile required)
  const defaultValues = {
    MC_HOST: form.MC_HOST?.value ?? form.querySelector('[name="MC_HOST"]')?.value ?? "",
    MC_HOSTS: form.MC_HOSTS?.value ?? form.querySelector('[name="MC_HOSTS"]')?.value ?? "",
    MC_PORT: form.MC_PORT?.value ?? form.querySelector('[name="MC_PORT"]')?.value ?? "",
    MC_VERSION: form.MC_VERSION?.value ?? form.querySelector('[name="MC_VERSION"]')?.value ?? "",
  };
  const defaultsBody = await rpc("saveSettings", { values: defaultValues }).catch((err) => ({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  }));
  if (!defaultsBody.ok) {
    if (msg) {
      msg.hidden = false;
      msg.textContent = defaultsBody.error || "Failed to save process defaults";
      msg.className = "settings-msg err";
    }
    return;
  }

  // Profile overrides when a profile is selected
  if (!selectedBotId) {
    if (msg) {
      msg.hidden = false;
      msg.textContent = "Process defaults saved · select a profile to also save profile overrides";
      msg.className = "settings-msg ok";
    }
    void fillConnectionDefaultsFromProcess();
    return;
  }
  const bot = (fleetState?.bots || []).find((b) => b.id === selectedBotId);
  if (!bot?.username) {
    if (msg) {
      msg.hidden = false;
      msg.textContent = "Process defaults saved · profile not found for overrides";
      msg.className = "settings-msg ok";
    }
    return;
  }
  const account = {
    id: selectedBotId,
    username: bot.username,
    host: form.host?.value?.trim() || undefined,
    port: num(form.port?.value),
    profile: {
      autoLobby: boolSel(form.autoLobby?.value),
      autoReconnect: boolSel(form.autoReconnect?.value),
      requiredServerPortals: num(form.requiredServerPortals?.value),
      portalRetryMs: num(form.portalRetryMs?.value),
      reconnectMs: num(form.reconnectMs?.value),
      reconnectMaxMs: num(form.reconnectMaxMs?.value),
      rateLimitCooldownMs: num(form.rateLimitCooldownMs?.value),
      captchaCooldownMs: num(form.captchaCooldownMs?.value),
      viewDistance: num(form.viewDistance?.value),
      version: form.version?.value?.trim() || undefined,
    },
  };
  const body = await rpc("fleetAddAccount", { account });
  if (msg) {
    msg.hidden = false;
    if (body.ok) {
      msg.textContent = "Connection saved (process defaults + profile)";
      msg.className = "settings-msg ok";
      await rpc("set", {
        autoLobby: account.profile.autoLobby,
        autoReconnect: account.profile.autoReconnect,
      }).catch(() => {});
    } else {
      msg.textContent = body.error || "Profile save failed (defaults were saved)";
      msg.className = "settings-msg err";
    }
  }
  await refreshFleet();
  const next = (fleetState?.bots || []).find((b) => b.id === selectedBotId);
  fillConnectionSettingsForm(next);
  fillProfileSettingsForm(next);
}

function syncDetectListenerUi(bot) {
  const onEl = document.getElementById("toggle-server-listener");
  const outEl = document.getElementById("toggle-server-listener-out");
  if (!onEl && !outEl) return;
  const p = bot?.profile || {};
  const on = p.serverListener === true;
  const out = p.serverListenerOutbound !== false;
  if (onEl && onEl.dataset.userTouched !== "1") {
    onEl.checked = on;
    onEl.closest(".task-toggle")?.classList.toggle("on", on);
  }
  if (outEl && outEl.dataset.userTouched !== "1") {
    outEl.checked = out;
    outEl.closest(".task-toggle")?.classList.toggle("on", out);
  }
}

async function saveDetectListenerFlags() {
  if (!selectedBotId) {
    push("err", "Select a profile first");
    return;
  }
  const bot = (fleetState?.bots || []).find((b) => b.id === selectedBotId);
  if (!bot?.username) {
    push("err", "Profile not found");
    return;
  }
  const onEl = document.getElementById("toggle-server-listener");
  const outEl = document.getElementById("toggle-server-listener-out");
  const serverListener = !!onEl?.checked;
  const serverListenerOutbound = outEl ? !!outEl.checked : true;
  onEl?.closest(".task-toggle")?.classList.toggle("on", serverListener);
  outEl?.closest(".task-toggle")?.classList.toggle("on", serverListenerOutbound);
  const account = {
    id: selectedBotId,
    username: bot.username,
    profile: {
      serverListener,
      serverListenerOutbound,
    },
  };
  const body = await rpc("fleetAddAccount", { account }).catch((err) => ({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  }));
  if (!body.ok) {
    push("err", body.error || "Failed to save packet listener");
    return;
  }
  push("sys", serverListener ? "Packet listener on" : "Packet listener off");
  await refreshFleet();
  const next = (fleetState?.bots || []).find((b) => b.id === selectedBotId);
  if (onEl) delete onEl.dataset.userTouched;
  if (outEl) delete outEl.dataset.userTouched;
  syncDetectListenerUi(next);
}

function fillProfileSettingsForm(bot) {
  fillConnectionSettingsForm(bot);
  syncDetectListenerUi(bot);
  const form = document.getElementById("profile-settings-form");
  const pathEl = document.getElementById("tab-settings-path");
  if (!form) return;
  if (!bot) {
    if (pathEl) pathEl.textContent = "Select a profile first";
    form.querySelectorAll("input, select").forEach((el) => {
      if ("value" in el) el.value = "";
    });
    return;
  }
  {
    const fileStem = String(bot.label || bot.username || bot.id || "profile")
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64) || "profile";
    if (pathEl) pathEl.textContent = `Profile · ${bot.label || bot.username} · Settings/Profiles/${fileStem}.json`;
  }
  const p = bot.profile || {};
  // Module fields only (connection lives under top-bar Settings)
  if (form.mapOutputDir) form.mapOutputDir.value = p.mapOutputDir || "./output";
  if (form.mapHomeName) form.mapHomeName.value = p.mapHomeName || "spawn";
  if (form.mapMode) form.mapMode.value = p.mapMode || "box";
  if (form.mapAutoStart) form.mapAutoStart.value = p.mapAutoStart === true ? "true" : "false";
  if (form.mapBoxX1) form.mapBoxX1.value = p.mapBox?.x1 ?? "20000";
  if (form.mapBoxZ1) form.mapBoxZ1.value = p.mapBox?.z1 ?? "20000";
  if (form.mapBoxX2) form.mapBoxX2.value = p.mapBox?.x2 ?? "24000";
  if (form.mapBoxZ2) form.mapBoxZ2.value = p.mapBox?.z2 ?? "24000";
  // Detection
  if (form.detectionRecheckMs) form.detectionRecheckMs.value = p.detectionRecheckMs ?? "3000";
  if (form.detectionPlayerLeaveGraceMs)
    form.detectionPlayerLeaveGraceMs.value = p.detectionPlayerLeaveGraceMs ?? "60000";
  if (form.detectionPlayers) form.detectionPlayers.value = p.detectionPlayers === false ? "false" : "true";
  if (form.detectionCrystals) form.detectionCrystals.value = p.detectionCrystals === false ? "false" : "true";
  if (form.detectionTnt) form.detectionTnt.value = p.detectionTnt === false ? "false" : "true";
  if (form.detectionExplosions) form.detectionExplosions.value = p.detectionExplosions === false ? "false" : "true";
  if (form.detectionCombat) form.detectionCombat.value = p.detectionCombat === false ? "false" : "true";
  // serverListener toggles live on Detect tab (syncDetectListenerUi)
  if (form.antiAfkIntervalMs) form.antiAfkIntervalMs.value = p.antiAfkIntervalMs ?? "60000";
  fillDetNotifyForm(form, bot);
}

async function saveProfileSettings() {
  const form = document.getElementById("profile-settings-form");
  const msg = document.getElementById("settings-msg");
  if (!form) return;

  const notifyPrefs = notifyPrefsFromForm(form);
  const anyNotify = Object.values(notifyPrefs).some(Boolean);
  if (anyNotify) {
    void ensureNotificationPermission().then((ok) => {
      if (ok) void registerServiceWorker();
    });
  }

  if (!selectedBotId) {
    if (msg) {
      msg.hidden = false;
      msg.textContent = "Select a profile first — module settings are per profile";
      msg.className = "settings-msg err";
    }
    return;
  }
  const num = (v) => (v === "" || v == null ? undefined : Number(v));
  const boolSel = (v) => (v === "true" ? true : v === "false" ? false : undefined);
  const boxNums = [
    num(form.mapBoxX1.value),
    num(form.mapBoxZ1.value),
    num(form.mapBoxX2.value),
    num(form.mapBoxZ2.value),
  ];
  const mapBox = boxNums.every((n) => typeof n === "number" && Number.isFinite(n))
    ? { x1: boxNums[0], z1: boxNums[1], x2: boxNums[2], z2: boxNums[3] }
    : undefined;
  const account = {
    id: selectedBotId,
    username: (fleetState?.bots || []).find((b) => b.id === selectedBotId)?.username,
    profile: {
      mapOutputDir: form.mapOutputDir?.value?.trim() || undefined,
      mapHomeName: form.mapHomeName?.value?.trim() || undefined,
      mapMode: form.mapMode?.value?.trim() || undefined,
      mapAutoStart: boolSel(form.mapAutoStart?.value),
      mapBox,
      detectionRecheckMs: num(form.detectionRecheckMs?.value),
      detectionPlayerLeaveGraceMs: num(form.detectionPlayerLeaveGraceMs?.value),
      detectionPlayers: boolSel(form.detectionPlayers?.value),
      detectionCrystals: boolSel(form.detectionCrystals?.value),
      detectionTnt: boolSel(form.detectionTnt?.value),
      detectionExplosions: boolSel(form.detectionExplosions?.value),
      detectionCombat: boolSel(form.detectionCombat?.value),
      antiAfkIntervalMs: num(form.antiAfkIntervalMs?.value),
      notifyPrefs,
    },
  };
  if (!account.username) {
    if (msg) {
      msg.hidden = false;
      msg.textContent = "Profile not found";
      msg.className = "settings-msg err";
    }
    return;
  }
  const body = await rpc("fleetAddAccount", { account });
  if (msg) {
    msg.hidden = false;
    if (body.ok) {
      msg.textContent = "Saved for this profile only · listener & bot settings applied to this account";
      msg.className = "settings-msg ok";
      closeTabSettings();
    } else {
      msg.textContent = body.error || "Save failed";
      msg.className = "settings-msg err";
    }
  }
  await refreshFleet();
  const bot = (fleetState?.bots || []).find((b) => b.id === selectedBotId);
  fillProfileSettingsForm(bot);
}

document.getElementById("settings-save")?.addEventListener("click", () => void saveProfileSettings());


document.getElementById("toggle-server-listener")?.addEventListener("change", (e) => {
  e.target.dataset.userTouched = "1";
  void saveDetectListenerFlags();
});
document.getElementById("toggle-server-listener-out")?.addEventListener("change", (e) => {
  e.target.dataset.userTouched = "1";
  void saveDetectListenerFlags();
});
document.getElementById("clear-server-listener")?.addEventListener("click", async () => {
  const msg = document.getElementById("settings-msg");
  if (!selectedBotId) {
    if (msg) {
      msg.hidden = false;
      msg.textContent = "Select a profile first to clear its listener log";
      msg.className = "settings-msg err";
    }
    push("err", "Select a profile first");
    return;
  }
  const bot = (fleetState?.bots || []).find((b) => b.id === selectedBotId);
  const username = bot?.username || "";
  const body = await rpc("clearServerListener", { username }).catch((err) => ({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  }));
  if (msg) {
    msg.hidden = false;
    if (body.ok) {
      const path = body.data?.path || body.data?.cleared?.[0] || "listener log";
      msg.textContent = `Listener log cleared · ${path}`;
      msg.className = "settings-msg ok";
      push("sys", `Cleared packet listener log for ${username || "profile"}`);
    } else {
      msg.textContent = body.error || "Clear failed";
      msg.className = "settings-msg err";
      push("err", body.error || "Clear listener failed");
    }
  }
});

document.getElementById("settings-save-connection")?.addEventListener("click", () => void saveConnectionSettings());

// Hook fillProfileSettings into setSelectedBot / renderFleet
const _origSetSelectedBot = setSelectedBot;
setSelectedBot = function (id) {
  _origSetSelectedBot(id);
  // Switching profile: reload module UI (announce messages, toggles, settings)
  const ann = document.getElementById("announce-json");
  if (ann) delete ann.dataset.touched;
  const bot = (fleetState?.bots || []).find((b) => b.id === selectedBotId) || null;
  fillProfileSettingsForm(bot);
  syncFeatureSwitches(bot);
  void loadSettingsForm(0);
};

document.getElementById("toggle-notify")?.addEventListener("change", async (e) => {
  const btn = e.target;
  const wrap = btn.closest(".task-toggle");
  const wantOn = !!btn.checked;
  btn.dataset.userTouched = "1";
  lockConnectionSwitch("notify", 600_000);

  if (!wantOn) {
    setNotifyPref(false);
    wrap?.classList.remove("on");
    push("sys", "Captcha notifications disabled");
    return;
  }

  const perm = notificationPermission();
  if (perm === "unsupported") {
    btn.checked = false;
    wrap?.classList.remove("on");
    setNotifyPref(false);
    push("err", "Notifications are not supported in this browser");
    return;
  }
  if (perm === "denied") {
    btn.checked = false;
    wrap?.classList.remove("on");
    setNotifyPref(false);
    push("err", "Notifications are blocked — enable them in browser / site settings");
    return;
  }

  const ok = await ensureNotificationPermission();
  if (!ok) {
    btn.checked = false;
    wrap?.classList.remove("on");
    setNotifyPref(false);
    return;
  }

  setNotifyPref(true);
  wrap?.classList.add("on");
  push("sys", "Captcha notifications enabled");
  try {
    new Notification("Fractal notifications on", {
      body: "You will be alerted when a captcha needs solving.",
      tag: "fractal-notify-test",
    });
  } catch {
    /* ignore */
  }
});
