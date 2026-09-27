// BOON Focus: during a focus session started from BOON, keeps the browser on the allowed tabs.
// Hagwon: the YouTube mix (no Shorts or other videos), a calculator and BOON.
// School: the class page, pages opened from it, email, a calculator and BOON.
// The session ends by itself when the timer runs out. Turning it off early takes a hard algebra question,
// and while that question is open every other tab is locked.
importScripts("algebra.js");

const EMAIL = ["mail.google.com", "gmail.com", "outlook.office.com", "outlook.office365.com", "outlook.live.com",
  "outlook.cloud.microsoft", "login.microsoftonline.com", "login.live.com"];
const CALCULATOR = ["desmos.com", "calculator.net"];
const BOON = ["localhost", "127.0.0.1"];
const SIGN_IN = ["accounts.google.com", "consent.youtube.com", "consent.google.com"];
const CLASS = ["classroom.google.com", "docs.google.com", "drive.google.com"];
const YOUTUBE = ["youtube.com", "youtu.be"];
// Navigations the student typed or picked themselves, as opposed to following a link.
const CHOSEN = new Set(["typed", "generated", "auto_bookmark", "keyword", "keyword_generated", "start_page"]);
const BLOCKED = chrome.runtime.getURL("blocked.html");
const QUIZ = chrome.runtime.getURL("quiz.html");
const OWN = chrome.runtime.getURL("");
// A blank new tab is fine: the student can type an allowed site into it.
const NEW_TAB = /^(chrome:\/\/(newtab|new-tab-page|new-tab-page-third-party)\/?$|chrome-search:\/\/local-ntp\/|about:blank$)/i;
const QUIZ_MINUTES = 5, QUIZ_TRIES = 3;
// A page opened from class may redirect through sign-in pages for this long before it is pinned to its sites.
const SETTLE_MS = 30000;

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };
const matches = (host, list) => !!host && list.some((a) => host === a || host.endsWith("." + a));
const isWeb = (url) => /^https?:\/\//i.test(url || "");

// ----- the session: one copy in memory, saved to storage for the island and for restarts -----
let cached, loading = null;
async function loadSession() {
  if (cached !== undefined) return cached;
  loading ||= chrome.storage.local.get("session").then(async ({ session }) => {
    // A session saved by the first version of this add-on can't be read by this one: drop it.
    if (session && !session.work) { session = null; await chrome.storage.local.remove("session"); }
    if (cached === undefined) cached = session || null;
    return cached;
  });
  return loading;
}
async function getSession() {
  const s = await loadSession();
  if (s && Date.now() >= s.end) { await endSession("time"); return null; }
  return s;
}
const saveSession = () => chrome.storage.local.set({ session: cached });

async function endSession(reason) {
  const s = cached;
  cached = null;
  await chrome.storage.local.remove("session");
  await chrome.alarms.clear("boon-focus-end");
  await chrome.alarms.clear("boon-quiz-end");
  if (s?.boonTabId != null) chrome.tabs.sendMessage(s.boonTabId, { type: "ended", reason }).catch(() => {});
}

// ----- what's allowed -----
// A YouTube lock: the mix (same list), the same video, or for other links the same page.
function ytLockOf(url) {
  try {
    const u = new URL(url);
    if (!matches(hostOf(url), YOUTUBE)) return null;
    const v = u.hostname === "youtu.be" ? u.pathname.slice(1) : u.searchParams.get("v");
    return { v: v || "", list: u.searchParams.get("list") || "", path: u.pathname };
  } catch { return null; }
}
function ytAllowed(url, lock) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (/^\/shorts(\/|$)/i.test(u.pathname)) return false;
  if (!lock) return false;
  if (lock.v || lock.list) {
    if (u.hostname === "youtu.be") return !!lock.v && u.pathname.slice(1) === lock.v;
    if (u.pathname !== "/watch") return false;
    return (!!lock.list && u.searchParams.get("list") === lock.list) || (!!lock.v && u.searchParams.get("v") === lock.v);
  }
  return u.pathname === lock.path;
}

// Sites any tab may show during this session.
function openToAll(s, url) {
  if (!url) return false;
  if (url.startsWith(OWN) || NEW_TAB.test(url)) return true;
  if (!isWeb(url)) return false;
  const host = hostOf(url);
  if (matches(host, YOUTUBE)) return s.mode === "hagwon" && ytAllowed(url, s.yt);
  return matches(host, s.allowed);
}

// Tabs that carry their own list of sites: the work tab and, in School, pages opened from class.
function tabRecord(s, tabId) {
  if (tabId === s.workTabId) return s.work;
  return s.okTabs?.[tabId] || null;
}
function recordAllows(rec, url) {
  if (!rec || !isWeb(url)) return false;
  const host = hostOf(url);
  if (!matches(host, rec.hosts)) return false;
  return !matches(host, YOUTUBE) || ytAllowed(url, rec.yt);
}

// Is this navigation in this tab allowed? Records the sites a fresh tab lands on while it settles.
function navAllowed(s, tabId, url, { chosen = false, redirect = false } = {}) {
  if (s.quiz && tabId === s.quiz.tabId) return url.startsWith(QUIZ);
  if (openToAll(s, url)) return true;
  const rec = tabRecord(s, tabId);
  if (!rec) return false;
  if (recordAllows(rec, url)) return true;
  // A page opened from class (or the work tab when it first loads) may land on a new site, and redirect
  // through sign-in pages while it settles; after that it stays on the sites it landed on.
  const settling = Date.now() < rec.settleUntil && (!rec.landed || redirect);
  if (!chosen && isWeb(url) && settling) {
    const host = hostOf(url);
    if (matches(host, YOUTUBE)) {
      if (/^\/shorts(\/|$)/i.test(new URL(url).pathname)) return false;
      rec.yt ||= ytLockOf(url);
      if (!ytAllowed(url, rec.yt)) return false;
    }
    if (!rec.hosts.includes(host)) rec.hosts.push(host);
    saveSession();
    return true;
  }
  return false;
}

// Can the student look at this tab right now?
function tabAllowed(s, tab) {
  if (s.quiz) return tab.id === s.quiz.tabId || (tab.pendingUrl || tab.url || "").startsWith(QUIZ);
  if (tab.id === s.workTabId || s.okTabs?.[tab.id]) return true;
  // A link opened from class in a new tab belongs to the class.
  if (s.mode === "school" && tab.openerTabId != null && (tab.openerTabId === s.workTabId || s.okTabs?.[tab.openerTabId])) {
    adoptTab(s, tab.id);
    return true;
  }
  return openToAll(s, tab.pendingUrl || tab.url);
}
function adoptTab(s, tabId) {
  if (s.okTabs[tabId]) return;
  s.okTabs[tabId] = { hosts: [], yt: null, settleUntil: Date.now() + SETTLE_MS };
  saveSession();
}

async function retry(fn) {
  // A tab being dragged can't be switched; keep trying until the drag ends (up to a minute).
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= 300 || !/cannot be edited right now|dragging/i.test(String(e?.message))) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

// Tabs this extension is creating right now, so the locks don't close its own tabs.
let selfCreating = 0;
let reopening = null;

async function openTab(url, nextTo = null) {
  selfCreating++;
  try {
    // Opened next to the work tab, Chrome goes back to it when this tab closes.
    const near = nextTo != null && await chrome.tabs.get(nextTo).catch(() => null);
    const tab = await chrome.tabs.create(near ? { url, active: true, windowId: near.windowId, openerTabId: near.id } : { url, active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return tab;
  } finally {
    selfCreating--;
  }
}

// Closing the tab and switching tabs fire together; reopen it only once.
function reopen() {
  return (reopening ||= (async () => {
    const s = await getSession();
    if (!s) return;
    if (s.quiz) {
      if (!(await chrome.tabs.get(s.quiz.tabId ?? -1).catch(() => null))) {
        const tab = await openTab(QUIZ, s.workTabId);
        if (cached?.quiz) { cached.quiz.tabId = tab.id; await saveSession(); }
      }
      return;
    }
    if (!(await chrome.tabs.get(s.workTabId ?? -1).catch(() => null))) {
      s.workTabId = null;   // so the new tab's own first load isn't caught while it is being made
      const tab = await openTab(s.url);
      s.workTabId = tab.id;
      s.work = { hosts: [hostOf(s.url)], yt: s.yt, settleUntil: Date.now() + SETTLE_MS };
      s.lastOk = s.url;
      await saveSession();
    }
  })().finally(() => { reopening = null; }));
}

async function bringBack() {
  await reopening;
  const s = await getSession();
  if (!s) return;
  const id = s.quiz ? s.quiz.tabId : s.workTabId;
  const tab = await chrome.tabs.get(id ?? -1).catch(() => null);
  if (!tab) return reopen();
  await retry(() => chrome.tabs.update(tab.id, { active: true }));
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
}

async function block(s, tabId) {
  if (s.quiz && tabId === s.quiz.tabId) { await retry(() => chrome.tabs.update(tabId, { url: QUIZ })).catch(() => {}); return; }
  if (tabId === s.workTabId) {
    // Back to the last allowed page; if that keeps bouncing (a redirect off the list), rest on the lock page.
    const now = Date.now();
    s.resets = (s.resets || []).filter((t) => now - t < 10000);
    s.resets.push(now);
    await saveSession();
    const to = s.resets.length > 3 ? BLOCKED : s.lastOk || s.url;
    await retry(() => chrome.tabs.update(tabId, { url: to })).catch(() => {});
    return;
  }
  await retry(() => chrome.tabs.update(tabId, { url: BLOCKED })).catch(() => {});
  await bringBack();
}

async function checkNav(tabId, url, how = {}) {
  const s = await getSession();
  if (!s) return;
  if (navAllowed(s, tabId, url, how)) {
    const rec = tabRecord(s, tabId);
    if (rec && how.commit && !how.redirect && isWeb(url) && !rec.landed) { rec.landed = true; await saveSession(); }
    if (tabId === s.workTabId && isWeb(url)) { s.lastOk = url; await saveSession(); }
    return;
  }
  // A background tab reloading (tabs restored after a restart) is left alone; it's caught when shown.
  if (how.reload && tabId !== s.workTabId && !tabRecord(s, tabId)) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.active) return;
  }
  await block(s, tabId);
}

// ----- the algebra question -----
async function startQuiz(s) {
  if (s.quiz) { await bringBack(); return { ok: true }; }
  // The answer stays in session storage, which the island and web pages can't read.
  const { answers, ordered, show, ...question } = BoonAlgebra.makeQuestion();
  await chrome.storage.session.set({ quizKey: { answers, ordered, show } });
  s.quiz = { ...question, until: Date.now() + QUIZ_MINUTES * 60000, tries: 0, tabId: null };
  s.lastQuiz = null;
  await saveSession();
  const tab = await openTab(QUIZ, s.workTabId);
  if (!cached?.quiz) return { ok: false };
  cached.quiz.tabId = tab.id;
  await saveSession();
  await chrome.alarms.create("boon-quiz-end", { when: s.quiz.until + 5000 });
  tellBoon(s, { type: "quiz", on: true });
  return { ok: true };
}

async function endQuiz(s, solved, last = null) {
  await chrome.alarms.clear("boon-quiz-end");
  await chrome.storage.session.remove("quizKey");
  if (solved) { await endSession("quiz"); return; }
  s.quiz = null;
  s.lastQuiz = last;
  await saveSession();
  tellBoon(s, { type: "quiz", on: false });
}

function tellBoon(s, msg) {
  if (s.boonTabId != null) chrome.tabs.sendMessage(s.boonTabId, msg).catch(() => {});
}

async function answerQuiz(value) {
  const s = await getSession();
  if (!s?.quiz) return { done: true, over: !s };
  const q = s.quiz;
  const { quizKey: key } = await chrome.storage.session.get("quizKey");
  if (!key) { await endQuiz(s, false); return { done: true, correct: false, lost: true }; }   // the add-on was reloaded
  if (Date.now() > q.until) { await endQuiz(s, false, { timeUp: true, answer: key.show }); return { done: true, correct: false, timeUp: true, answer: key.show }; }
  if (BoonAlgebra.checkAnswer(key, value)) { await endQuiz(s, true); return { done: true, correct: true }; }
  q.tries++;
  if (q.tries >= QUIZ_TRIES) { await endQuiz(s, false, { answer: key.show }); return { done: true, correct: false, answer: key.show }; }
  await saveSession();
  return { done: false, correct: false, triesLeft: QUIZ_TRIES - q.tries };
}

// ----- messages from BOON (through bridge.js), the island and the extension's own pages -----
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    const type = msg?.type;
    if (type === "ping") return { ok: true };
    if (type === "status") {
      const s = await getSession();
      return { ok: true, session: s && { mode: s.mode, url: s.url, text: s.text, rid: s.rid, start: s.start, end: s.end, minEnd: s.minEnd, quiz: !!s.quiz } };
    }
    if (type === "bringBack") { const s = await getSession(); if (s) await bringBack(); return { ok: !!s }; }
    if (type === "check") {
      // The island saw its tab come into view: send the student back if this tab isn't allowed.
      const s = await getSession();
      if (s && sender.tab && !tabAllowed(s, sender.tab)) await bringBack();
      return { ok: true };
    }
    if (type === "turnOff") {
      const s = await getSession();
      if (!s) return { ok: true, over: true };
      return await startQuiz(s);
    }
    if (type === "quizStatus") {
      const s = await getSession();
      if (!s?.quiz) return { active: false, over: !s, last: s?.lastQuiz || null };
      const q = s.quiz;
      if (Date.now() > q.until) {
        const { quizKey: key } = await chrome.storage.session.get("quizKey");
        const last = { timeUp: true, answer: key?.show || "" };
        await endQuiz(s, false, last);
        return { active: false, last };
      }
      return { active: true, html: q.html, prompt: q.prompt, until: q.until, triesLeft: QUIZ_TRIES - q.tries, text: s.text };
    }
    if (type === "answer") {
      if (!String(sender.url || "").startsWith(QUIZ)) return { ok: false };
      return await answerQuiz(String(msg.value || "").slice(0, 200));
    }
    if (type === "stop") {
      const s = await getSession();
      if (!s) return { ok: true };
      if (Date.now() < s.minEnd) return { ok: false, left: s.minEnd - Date.now() };
      await endSession("finished");
      return { ok: true };
    }
    if (type === "start") {
      if (await getSession()) return { ok: false, running: true, error: "A focus session is already running." };
      const url = String(msg.url || "");
      if (!isWeb(url)) return { ok: false, error: "No link to open." };
      const mode = msg.mode === "hagwon" ? "hagwon" : "school";
      const minutes = Math.max(10, Math.min(180, Number(msg.minutes) || 25));
      const minMinutes = Math.min(minutes, Math.max(10, Number(msg.minMinutes) || 10));
      const now = Date.now();
      const host = hostOf(url);
      const s = {
        mode, url, text: String(msg.text || "Focus").slice(0, 120), rid: String(msg.rid || ""),
        start: now, end: now + minutes * 60000, minEnd: now + minMinutes * 60000,
        boonTabId: sender.tab?.id ?? null, workTabId: null, okTabs: {}, quiz: null,
        yt: ytLockOf(url), lastOk: url,
        allowed: mode === "hagwon"
          ? [...CALCULATOR, ...BOON, ...SIGN_IN, ...(matches(host, YOUTUBE) ? [] : [host])]
          : [...(matches(host, YOUTUBE) ? [] : [host]), ...CLASS, ...EMAIL, ...CALCULATOR, ...BOON, ...SIGN_IN],
      };
      s.work = { hosts: [host], yt: s.yt, settleUntil: now + SETTLE_MS };
      // The work tab is made before the session is live, so the locks don't catch it.
      const tab = await openTab(url);
      s.workTabId = tab.id;
      cached = s;
      await saveSession();
      await chrome.alarms.create("boon-focus-end", { when: s.end });
      showIslandEverywhere();
      return { ok: true, start: s.start, end: s.end, minEnd: s.minEnd, mode };
    }
    return null;
  })().then(reply, (e) => reply({ ok: false, error: String(e?.message || e) }));
  return true;
});

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === "boon-focus-end") { await loadSession(); if (cached) await endSession("time"); }
  if (a.name === "boon-quiz-end") {
    // A backstop in case the question page wasn't open to end it itself.
    const s = await getSession();
    if (!s?.quiz || Date.now() < s.quiz.until) return;
    const { quizKey: key } = await chrome.storage.session.get("quizKey");
    await endQuiz(s, false, { timeUp: true, answer: key?.show || "" });
    await bringBack();
  }
});

// Tabs that were open before the extension was (re)loaded don't have the island yet.
async function showIslandEverywhere() {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }).catch(() => []);
  for (const t of tabs) chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["island.js"] }).catch(() => {});
}

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

// Dropping a dragged tab into another window, or moving it, can land on a locked tab.
const recheckWindow = async (windowId) => {
  const s = await getSession();
  if (!s) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
  if (tab && !tabAllowed(s, tab)) await bringBack();
};
chrome.tabs.onAttached.addListener((tabId, { newWindowId }) => recheckWindow(newWindowId));
chrome.tabs.onMoved.addListener((tabId, { windowId }) => recheckWindow(windowId));

chrome.tabs.onCreated.addListener(async (tab) => {
  if (selfCreating) return;
  const s = await getSession();
  if (!s || tab.id === s.workTabId || (tab.pendingUrl || tab.url || "").startsWith(OWN)) return;
  if (s.quiz) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    await bringBack();
    return;
  }
  // A link opened from the class page (or a page opened from it) is part of the class.
  if (s.mode === "school" && tab.openerTabId != null && (tab.openerTabId === s.workTabId || s.okTabs[tab.openerTabId])) adoptTab(s, tab.id);
});

chrome.webNavigation.onCreatedNavigationTarget.addListener(async ({ sourceTabId, tabId }) => {
  const s = await getSession();
  if (!s || s.mode !== "school" || s.quiz || s.okTabs[tabId]) return;
  if (sourceTabId === s.workTabId || s.okTabs[sourceTabId]) adoptTab(s, tabId);
});

chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url, transitionType, transitionQualifiers = [] }) => {
  if (frameId !== 0) return;
  const chosen = CHOSEN.has(transitionType) || transitionQualifiers.includes("from_address_bar");
  const redirect = transitionQualifiers.includes("server_redirect") || transitionQualifiers.includes("client_redirect");
  checkNav(tabId, url, { chosen, redirect, commit: true, reload: transitionType === "reload" });
});

// YouTube and other single-page sites change pages without a new load (this is how Shorts open).
chrome.webNavigation.onHistoryStateUpdated.addListener(({ tabId, frameId, url }) => {
  if (frameId === 0) checkNav(tabId, url);
});

// A page that failed to load (or the offline dino page) never commits; check where it was going.
chrome.webNavigation.onErrorOccurred.addListener(({ tabId, frameId, url, error }) => {
  if (frameId === 0 && error !== "net::ERR_ABORTED") checkNav(tabId, url, { chosen: true });
});

// chrome:// pages (extensions, settings, history, dino) don't fire the navigation events above.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url || isWeb(info.url) || info.url.startsWith(OWN) || NEW_TAB.test(info.url)) return;
  const s = await getSession();
  if (s) await block(s, tabId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await getSession();
  if (!s) return;
  if (tabId === s.workTabId || (s.quiz && tabId === s.quiz.tabId)) { await reopen(); return; }
  if (s.okTabs[tabId]) { delete s.okTabs[tabId]; await saveSession(); }
});

// A browser restart mid-session: tab ids start over, so forget the old ones and open the work fresh.
// Restored tabs are left alone; the locks catch them when they're shown.
chrome.runtime.onStartup.addListener(async () => {
  const s = await getSession();
  if (!s) return;
  s.workTabId = null;
  s.okTabs = {};
  s.boonTabId = null;
  s.quiz = null;
  await saveSession();
  await chrome.alarms.create("boon-focus-end", { when: s.end });
  await reopen();
});

// Reloading the extension mid-session keeps the session; put the timer and the island back.
chrome.runtime.onInstalled.addListener(async () => {
  const s = await getSession();
  if (!s) return;
  await chrome.alarms.create("boon-focus-end", { when: s.end });
  if (s.quiz) await chrome.alarms.create("boon-quiz-end", { when: s.quiz.until + 5000 });
  showIslandEverywhere();
});
