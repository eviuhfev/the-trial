// BOON Focus: during a focus session started from BOON, keeps the browser on the allowed tabs.
// Hagwon: only the YouTube tab. School: the class page, pages opened from it, email, a calculator and BOON.
// A session can't be ended before its minimum time; it ends by itself when the timer runs out.

const EMAIL = ["mail.google.com", "gmail.com", "outlook.office.com", "outlook.live.com"];
const CALCULATOR = ["desmos.com", "calculator.net"];
const BOON = ["localhost", "127.0.0.1"];
const SIGN_IN = ["accounts.google.com"];
// Navigations the student typed or picked themselves, as opposed to following a link.
const CHOSEN = new Set(["typed", "generated", "auto_bookmark", "keyword", "keyword_generated", "start_page"]);
const BLOCKED = chrome.runtime.getURL("blocked.html");

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };
const matches = (host, list) => !!host && list.some((a) => host === a || host.endsWith("." + a));

async function getSession() {
  const { session } = await chrome.storage.local.get("session");
  if (!session) return null;
  if (Date.now() >= session.end) { await endSession("time"); return null; }
  return session;
}
const saveSession = (session) => chrome.storage.local.set({ session });

function urlAllowed(s, url) {
  if (!url) return false;
  if (url.startsWith(BLOCKED)) return true;
  return matches(hostOf(url), s.allowed);
}
function tabAllowed(s, tab) {
  if (tab.id === s.workTabId) return true;
  if (s.mode === "hagwon") return false;
  if (s.okTabs.includes(tab.id)) return true;
  return urlAllowed(s, tab.pendingUrl || tab.url);
}

async function retry(fn) {
  for (let i = 0; i < 5; i++) {
    try { return await fn(); } catch (e) {
      if (!/cannot be edited right now|dragging/i.test(String(e?.message))) throw e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

// Tabs this extension is creating right now, so the locks don't close its own work tab.
let selfCreating = 0;
let reopening = null;

async function openWork(s) {
  selfCreating++;
  try {
    const tab = await chrome.tabs.create({ url: s.url, active: true });
    s.workTabId = tab.id;
    await saveSession(s);
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  } finally {
    selfCreating--;
  }
}

// Closing the work tab and switching tabs fire together; reopen it only once.
function reopenWork() {
  return (reopening ||= (async () => {
    const s = await getSession();
    if (!s) return;
    const tab = await chrome.tabs.get(s.workTabId).catch(() => null);
    if (!tab) await openWork(s);
  })().finally(() => { reopening = null; }));
}

async function bringBack() {
  await reopening;
  const s = await getSession();
  if (!s) return;
  const tab = await chrome.tabs.get(s.workTabId).catch(() => null);
  if (!tab) return reopenWork();
  await retry(() => chrome.tabs.update(tab.id, { active: true }));
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
}

async function block(s, tabId) {
  if (tabId === s.workTabId) {
    await retry(() => chrome.tabs.update(tabId, { url: s.url }));
    return;
  }
  await retry(() => chrome.tabs.update(tabId, { url: BLOCKED })).catch(() => {});
  await bringBack();
}

async function endSession(reason) {
  const { session } = await chrome.storage.local.get("session");
  await chrome.storage.local.remove("session");
  await chrome.alarms.clear("boon-focus-end");
  if (session?.boonTabId != null) chrome.tabs.sendMessage(session.boonTabId, { type: "ended", reason }).catch(() => {});
}

// ----- messages from BOON (through bridge.js) and from the blocked page -----
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg?.type === "ping") return { ok: true };
    if (msg?.type === "status") return await getSession();
    if (msg?.type === "bringBack") { const s = await getSession(); if (s) await bringBack(); return { ok: !!s }; }
    if (msg?.type === "stop") {
      const s = await getSession();
      if (!s) return { ok: true };
      if (Date.now() < s.minEnd) return { ok: false, left: s.minEnd - Date.now() };
      await endSession("finished");
      return { ok: true };
    }
    if (msg?.type === "start") {
      if (await getSession()) return { ok: false, error: "A focus session is already running." };
      const url = String(msg.url || "");
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: "No link to open." };
      const mode = msg.mode === "hagwon" ? "hagwon" : "school";
      const minutes = Math.max(10, Math.min(180, Number(msg.minutes) || 25));
      const minMinutes = Math.min(minutes, Math.max(10, Number(msg.minMinutes) || 10));
      const now = Date.now();
      const s = {
        mode, url, text: String(msg.text || "Focus").slice(0, 120), rid: String(msg.rid || ""),
        start: now, end: now + minutes * 60000, minEnd: now + minMinutes * 60000,
        boonTabId: sender.tab?.id ?? null, okTabs: [],
        allowed: mode === "hagwon" ? ["youtube.com", "youtu.be", hostOf(url)]
          : [hostOf(url), "classroom.google.com", ...EMAIL, ...CALCULATOR, ...BOON, ...SIGN_IN],
      };
      await openWork(s);   // create the tab before the session is live, so the locks don't catch it
      await chrome.alarms.create("boon-focus-end", { when: s.end });
      return { ok: true, start: s.start, end: s.end, minEnd: s.minEnd, mode };
    }
    return null;
  })().then(reply, (e) => reply({ ok: false, error: String(e?.message || e) }));
  return true;
});

chrome.alarms.onAlarm.addListener((a) => { if (a.name === "boon-focus-end") endSession("time"); });

// ----- the locks -----
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const s = await getSession();
  if (!s) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && !tabAllowed(s, tab)) await bringBack();
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;   // another app (Calculator, Mail) is fine
  const s = await getSession();
  if (!s) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab && !tabAllowed(s, tab)) await bringBack();
});

chrome.tabs.onCreated.addListener(async (tab) => {
  if (selfCreating) return;
  const s = await getSession();
  if (!s || tab.id === s.workTabId) return;
  if (s.mode === "hagwon") {
    await chrome.tabs.remove(tab.id).catch(() => {});
    await bringBack();
    return;
  }
  // A link opened from the class page (or a page opened from it) is part of the class.
  if (tab.openerTabId != null && (tab.openerTabId === s.workTabId || s.okTabs.includes(tab.openerTabId))) {
    s.okTabs.push(tab.id);
    await saveSession(s);
  }
});

chrome.webNavigation.onCreatedNavigationTarget.addListener(async ({ sourceTabId, tabId }) => {
  const s = await getSession();
  if (!s || s.mode !== "school" || s.okTabs.includes(tabId)) return;
  const source = await chrome.tabs.get(sourceTabId).catch(() => null);
  if (sourceTabId === s.workTabId || s.okTabs.includes(sourceTabId) || matches(hostOf(source?.url), ["classroom.google.com"])) {
    s.okTabs.push(tabId);
    await saveSession(s);
  }
});

chrome.webNavigation.onCommitted.addListener(async ({ tabId, frameId, url, transitionType, transitionQualifiers = [] }) => {
  if (frameId !== 0) return;
  const s = await getSession();
  if (!s || urlAllowed(s, url)) return;
  if (s.mode === "school") {
    const chosen = CHOSEN.has(transitionType) || transitionQualifiers.includes("from_address_bar");
    if ((tabId === s.workTabId || s.okTabs.includes(tabId)) && !chosen) return;   // following links from class
    if (/^(chrome|about|edge|brave):/i.test(url) && tabId !== s.workTabId) return; // new-tab pages: caught when shown
  }
  await block(s, tabId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await getSession();
  if (!s) return;
  if (tabId === s.workTabId) { await reopenWork(); return; }
  if (s.okTabs.includes(tabId)) { s.okTabs = s.okTabs.filter((t) => t !== tabId); await saveSession(s); }
});

// A restart or browser relaunch mid-session: keep the timer and the locks.
chrome.runtime.onStartup.addListener(async () => {
  const s = await getSession();
  if (!s) return;
  await chrome.alarms.create("boon-focus-end", { when: s.end });
  await reopenWork();
});
