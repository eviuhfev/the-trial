// BOON Focus: during a focus session started from BOON, keeps the browser on the allowed tabs.
// Hagwon: the YouTube mix (no Shorts or other videos), a calculator and BOON.
// School: the class page, pages opened from it, email, a calculator and BOON.
// The session ends by itself when the timer runs out. Turning it off early takes a hard algebra question,
// and while that question is open every other tab is locked. Leaving Chrome (another app or desktop) brings
// the student back after a moment.
importScripts("algebra.js");

const EMAIL = ["mail.google.com", "gmail.com", "outlook.office.com", "outlook.office365.com", "outlook.live.com",
  "outlook.cloud.microsoft", "login.microsoftonline.com", "login.live.com"];
const CALCULATOR = ["desmos.com", "calculator.net"];
const BOON = ["localhost", "127.0.0.1"];
const SIGN_IN = ["accounts.google.com", "consent.youtube.com", "consent.google.com"];
const CLASS = ["classroom.google.com", "docs.google.com", "drive.google.com"];
const YOUTUBE = ["youtube.com", "youtu.be"];
// Pages the student can type their own links into: a link opened from them isn't class material.
const WRITABLE = ["docs.google.com", "drive.google.com", ...EMAIL, ...BOON];
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
// Google's link redirector (links in Classroom, Docs and Gmail pass through it): allowed as a hop, never pinned.
const isHop = (url) => /^https?:\/\/(www\.)?google\.[a-z.]+\/url\?/i.test(url || "");
// The tab with this id, or null. (chrome.tabs.get throws on the spot, not later, for an id like -1.)
const getTab = async (id) => { try { return id == null ? null : await chrome.tabs.get(id); } catch { return null; } };

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
  // Every BOON tab hears about this through bridge.js, which watches this storage.
  await chrome.storage.local.set({ session: null, lastEnd: { reason, at: Date.now() } });
  await chrome.alarms.clear("boon-focus-end");
  await chrome.alarms.clear("boon-quiz-end");
  await chrome.storage.session.remove("quizKey");
  // Give back what the session quieted: sound in old tabs, and windows it minimized.
  for (const id of s?.muted || []) chrome.tabs.update(id, { muted: false }).catch(() => {});
  for (const id of s?.minimized || []) chrome.windows.update(id, { state: "normal" }).catch(() => {});
}

// ----- the safety stop -----
// If the lock can't open or show the work (or the question), it would only leave locked pages, so after a few
// failures it turns focus off instead of trapping Chrome. Failures within a couple of seconds of each other
// count as one (Chrome quitting fails everything at once), and the stop needs them spread over at least
// SAFETY_SPREAD_MS. A tab being dragged is never a failure: the drag always ends.
const SAFETY_FAILS = 3, SAFETY_WINDOW_MS = 120000, SAFETY_SPREAD_MS = 10000, SAFETY_BURST_MS = 2000;
let failures = [];
async function trouble() {
  if (!cached) return;
  const now = Date.now();
  failures = failures.filter((t) => now - t < SAFETY_WINDOW_MS);
  if (failures.length && now - failures[failures.length - 1] < SAFETY_BURST_MS) return;
  failures.push(now);
  if (failures.length >= SAFETY_FAILS && now - failures[0] >= SAFETY_SPREAD_MS) {
    failures = [];
    await endSession("safety");
  }
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
    // The page the link itself points to, like a playlist page.
    if (lock.path !== "/watch" && u.pathname === lock.path && (!lock.list || u.searchParams.get("list") === lock.list)) return true;
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
  if (!rec.hosts.includes(host)) return false;   // exactly the sites it landed on, not their subdomains
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
    if (isHop(url)) return true;   // the redirect that follows decides
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
  return openToAll(s, tab.pendingUrl || tab.url);
}
// Same, but also recognises a link from class that opened in a new tab and is shown before the add-on
// hears where it came from.
async function allowedNow(s, tab) {
  if (tabAllowed(s, tab)) return true;
  const u = tab.pendingUrl || tab.url || "";
  if (s.quiz || tab.openerTabId == null || /^chrome/i.test(u) || !(await fromClass(s, tab.openerTabId))) return false;
  adoptTab(s, tab.id);
  return true;
}
// Is this tab showing the class (or class material), so links it opens are class material too?
async function fromClass(s, sourceTabId) {
  if (s.mode !== "school" || (sourceTabId !== s.workTabId && !s.okTabs[sourceTabId])) return false;
  const src = await getTab(sourceTabId);
  const host = hostOf(src?.url || "");
  if (!host) return false;
  if (sourceTabId === s.workTabId) return host === "classroom.google.com" || host === hostOf(s.url);
  return !matches(host, WRITABLE);
}
function adoptTab(s, tabId) {
  if (s.okTabs[tabId]) return;
  s.okTabs[tabId] = { hosts: [], yt: null, settleUntil: Date.now() + SETTLE_MS };
  saveSession();
}

async function retry(fn) {
  // A tab being dragged can't be switched; keep trying until the drag ends (as long as it takes while
  // focus is on, otherwise up to a minute).
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if ((i >= 300 && !cached) || !/cannot be edited right now|dragging/i.test(String(e?.message))) throw e;
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
    const near = await getTab(nextTo);
    let tab;
    try {
      tab = await retry(() => chrome.tabs.create(near ? { url, active: true, windowId: near.windowId, openerTabId: near.id } : { url, active: true }));
    } catch {
      // No Chrome window is open (on a Mac, Chrome keeps running after the last one closes): open one.
      try { tab = (await retry(() => chrome.windows.create({ url, focused: true }))).tabs[0]; } catch (e) { await trouble(); throw e; }
    }
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
      if (!(await getTab(s.quiz.tabId))) {
        const tab = await openTab(QUIZ, s.workTabId).catch(() => null);
        if (tab && cached?.quiz) { cached.quiz.tabId = tab.id; await saveSession(); }
      }
      return;
    }
    if (!(await getTab(s.workTabId))) {
      s.workTabId = null;   // so the new tab's own first load isn't caught while it is being made
      const tab = await openTab(s.url).catch(() => null);
      if (!tab) return;
      s.workTabId = tab.id;
      s.work = { hosts: [hostOf(s.url)], yt: s.yt, settleUntil: Date.now() + SETTLE_MS };
      s.lastOk = s.url;
      await saveSession();
    }
  })().finally(() => { reopening = null; }));
}

// Many events can ask at once (a drag fires several); run one at a time, and once more if asked meanwhile.
let bringing = null, bringAgain = false;
function bringBack() {
  if (bringing) { bringAgain = true; return bringing; }
  return (bringing = (async () => {
    do { bringAgain = false; await bringBackOnce(); } while (bringAgain && cached);
  })().finally(() => { bringing = null; }));
}
async function bringBackOnce() {
  await reopening;
  const s = await getSession();
  if (!s) return;
  const id = s.quiz ? s.quiz.tabId : s.workTabId;
  const tab = await getTab(id);
  if (!tab) return reopen();
  try { await retry(() => chrome.tabs.update(tab.id, { active: true })); } catch {
    // Closed just now: open it again. Still there but it won't show: that counts toward the safety stop.
    if (!cached) return;
    if (!(await getTab(tab.id))) return reopen();
    await trouble();
    return;
  }
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  await sweep(s);
}

// Tabs the lock can't switch away from on their own: silence ones playing sound, and minimize other
// windows that show a locked page (a video in a second window, or anything during the question).
async function sweep(s) {
  const mainId = s.quiz ? s.quiz.tabId : s.workTabId;
  const main = await getTab(mainId);
  const tabs = await chrome.tabs.query({}).catch(() => []);
  let changed = false;
  for (const t of tabs) {
    if (t.id === mainId || await allowedNow(s, t)) continue;
    if (t.audible && !t.mutedInfo?.muted) {
      await chrome.tabs.update(t.id, { muted: true }).catch(() => {});
      (s.muted ||= []).push(t.id);
      changed = true;
    }
    if (t.active && main && t.windowId !== main.windowId) {
      await chrome.windows.update(t.windowId, { state: "minimized" }).catch(() => {});
      if (!(s.minimized ||= []).includes(t.windowId)) s.minimized.push(t.windowId);
      changed = true;
    }
  }
  if (changed && cached === s) await saveSession();
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
    if (rec && how.commit && !how.redirect && isWeb(url) && !isHop(url) && !rec.landed) { rec.landed = true; await saveSession(); }
    if (tabId === s.workTabId && isWeb(url)) { s.lastOk = url; await saveSession(); }
    return;
  }
  // A background tab reloading (tabs restored after a restart) is left alone; it's caught when shown.
  if (how.reload && tabId !== s.workTabId && !tabRecord(s, tabId)) {
    const tab = await getTab(tabId);
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
  const tab = await openTab(QUIZ, s.workTabId).catch(() => null);
  if (!tab) { if (cached?.quiz) await endQuiz(cached, false); return { ok: false, error: "Couldn't open the question." }; }
  if (!cached?.quiz) return { ok: false };
  cached.quiz.tabId = tab.id;
  await saveSession();
  await chrome.alarms.create("boon-quiz-end", { when: s.quiz.until + 5000 });
  await sweep(s);
  return { ok: true };
}

async function endQuiz(s, solved, last = null) {
  await chrome.alarms.clear("boon-quiz-end");
  await chrome.storage.session.remove("quizKey");
  if (solved) { await endSession("quiz"); return; }
  s.quiz = null;
  s.lastQuiz = last;
  await saveSession();
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
      return {
        ok: true, incognito: await chrome.extension.isAllowedIncognitoAccess(),
        session: s && { mode: s.mode, url: s.url, text: s.text, rid: s.rid, start: s.start, end: s.end, minEnd: s.minEnd, quiz: !!s.quiz, workTab: sender.tab?.id === s.workTabId },
      };
    }
    if (type === "restoreWork") {
      // The lock page in the work tab: load the work again.
      const s = await getSession();
      if (!s || sender.tab?.id !== s.workTabId) return { ok: false };
      s.resets = [];
      await saveSession();
      await retry(() => chrome.tabs.update(s.workTabId, { url: s.lastOk || s.url })).catch(() => {});
      return { ok: true };
    }
    if (type === "bringBack") { const s = await getSession(); if (s) await bringBack(); return { ok: !!s }; }
    if (type === "check") {
      // The island saw its tab come into view: send the student back if this tab isn't allowed.
      const s = await getSession();
      if (s && sender.tab && !(await allowedNow(s, sender.tab))) await bringBack();
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
      failures = [];
      // The work tab is made before the session is live, so the locks don't catch it.
      const tab = await openTab(url);
      s.workTabId = tab.id;
      cached = s;
      await saveSession();
      await chrome.alarms.create("boon-focus-end", { when: s.end });
      showIslandEverywhere();
      await sweep(s);
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
  const tab = await getTab(tabId);
  if (tab && !(await allowedNow(s, tab))) await bringBack();
});

// ----- leaving Chrome -----
// A three-finger swipe to another desktop, ⌘Tab or the Dock takes the student out of Chrome. Chrome can't see
// other apps, only that none of its windows has focus, so after a short grace it brings its window back (on a
// Mac that also switches back to Chrome's desktop). Quitting Chrome (⌘Q) still ends this, so it can never trap
// the Mac, and if Chrome can't bring itself to the front it stops trying until the student comes back.
const AWAY_GRACE_MS = 2000, AWAY_RETRY_MS = 3000, AWAY_TRIES = 10;
let awayTimer = 0, awayTries = 0;
function leftChrome() {
  if (awayTimer) return;
  awayTries = 0;
  awayTimer = setTimeout(pullBack, AWAY_GRACE_MS);
}
function cameBack() {
  clearTimeout(awayTimer);
  awayTimer = 0;
}
async function pullBack() {
  awayTimer = 0;
  const s = await getSession();
  if (!s) return;
  const wins = await chrome.windows.getAll().catch(() => null);
  if (!wins || wins.some((w) => w.focused) || awayTries >= AWAY_TRIES) return;
  if (awayTries++ === 0) { s.left = (s.left || 0) + 1; await saveSession(); }
  // Back to the window they left if it shows an allowed page (a file picker may be open there); otherwise to
  // the work, or the question.
  const last = s.quiz ? null : await chrome.windows.getLastFocused({ populate: true }).catch(() => null);
  const tab = last?.tabs?.find((t) => t.active);
  if (tab && (await allowedNow(s, tab))) await chrome.windows.update(last.id, { focused: true }).catch(() => {});
  else await bringBack();
  if (!awayTimer) awayTimer = setTimeout(pullBack, AWAY_RETRY_MS);
}

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) { leftChrome(); return; }
  cameBack();
  const s = await getSession();
  if (!s) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab && !(await allowedNow(s, tab))) await bringBack();
});

// Dropping a dragged tab into another window, or moving it, can land on a locked tab.
const recheckWindow = async (windowId) => {
  const s = await getSession();
  if (!s) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
  if (tab && !(await allowedNow(s, tab))) await bringBack();
};
chrome.tabs.onAttached.addListener((tabId, { newWindowId }) => recheckWindow(newWindowId));
chrome.tabs.onMoved.addListener((tabId, { windowId }) => recheckWindow(windowId));

chrome.tabs.onCreated.addListener(async (tab) => {
  if (selfCreating) return;
  const s = await getSession();
  if (!s || tab.id === s.workTabId || (tab.pendingUrl || tab.url || "").startsWith(OWN)) return;
  if (s.quiz) {
    // The question's own tab is gone (its window was closed): show the question here instead. Not in an
    // incognito tab, where Chrome won't show the add-on's pages; that one is locked and the question reopens.
    if (!tab.incognito && !(await getTab(s.quiz.tabId))) {
      s.quiz.tabId = tab.id;
      await saveSession();
      await retry(() => chrome.tabs.update(tab.id, { url: QUIZ })).catch(() => {});
      return;
    }
    // Locked, never closed: closing it would also close a new window, and Chrome would seem not to open.
    await block(s, tab.id);
  }
});

// A link from the class page (or from class material) that opens a new tab is class material too.
chrome.webNavigation.onCreatedNavigationTarget.addListener(async ({ sourceTabId, tabId }) => {
  const s = await getSession();
  if (!s || s.quiz || s.okTabs[tabId]) return;
  if (await fromClass(s, sourceTabId)) adoptTab(s, tabId);
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

chrome.tabs.onRemoved.addListener(async (tabId, { isWindowClosing }) => {
  const s = await getSession();
  if (!s) return;
  if (tabId === s.workTabId || (s.quiz && tabId === s.quiz.tabId)) {
    // Its window closed: wait a moment, so quitting Chrome isn't met with a new window.
    if (isWindowClosing) await new Promise((r) => setTimeout(r, 1000));
    await reopen();
    return;
  }
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
  s.muted = [];
  s.minimized = [];
  await chrome.alarms.create("boon-focus-end", { when: s.end });
  await reopen();
  const now = await getSession();
  if (now) await sweep(now);
});

// Reloading the extension mid-session keeps the session; put the timer and the island back.
chrome.runtime.onInstalled.addListener(async () => {
  const s = await getSession();
  if (!s) return;
  await chrome.alarms.create("boon-focus-end", { when: s.end });
  if (s.quiz) await chrome.alarms.create("boon-quiz-end", { when: s.quiz.until + 5000 });
  showIslandEverywhere();
});
