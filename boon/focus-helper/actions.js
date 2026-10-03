#!/usr/bin/osascript -l JavaScript
// BOON Mac actions: adds a Mac Reminders item, a Calendar event, opens an app, searches the web, or reads a page,
// for BOON's robot. Chrome runs this through boon-focus-host, the same helper that hides other apps during focus;
// it works any time, not just then. The first use of Reminders or Calendar shows macOS's own "BOON Focus Helper
// wants to..." pop-up once; the user has to click Allow there.
//   osascript -l JavaScript actions.js '<request JSON>'   runs one action, prints its result as JSON
// Request: {"id": <number>, "action": "create_reminder"|"create_event"|"open_app"|"web_search"|"fetch_url", ...
// fields below}. The app name for open_app is checked again here against the same allow-list BOON shows the
// model, since this script is the last place that can say no before anything happens on the Mac.
const APPS = ["Notes", "Reminders", "Calendar", "Music", "Safari", "Messages", "Mail", "Maps", "Photos", "Calculator", "FaceTime", "Spotify"];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const MAX_BODY = 500000;   // bytes of response read before BOON's robot sees any of it
const MAX_TEXT = 6000;     // chars of extracted page text handed back (keeps prompts small)
const CONNECT_TIMEOUT = 5; // seconds
const FETCH_TIMEOUT = 12;  // seconds, whole request

function str(v, max) {
  const s = String(v == null ? "" : v).trim().slice(0, max);
  if (!s) throw new Error("missing text");
  return s;
}
function when(v) {
  const d = new Date(v);
  if (isNaN(d.getTime())) throw new Error(`"${v}" isn't a date BOON can read`);
  return d;
}

function sh(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Blocks a link that points back at this Mac or its local network (BOON's own Ollama port, a router page, etc.),
// so a search result or a pasted link can't make "read this page" poke something that was never meant to answer
// to the internet. It can't know where a public hostname's DNS actually resolves, so a name that later resolves
// to a private address is a gap this doesn't close — same trust level as everything else here runs on the user's
// say-so (see the BOON Mac actions note in the project's memory).
function checkUrl(raw) {
  const s = String(raw == null ? "" : raw).trim().slice(0, 2000);
  const m = /^(https?):\/\/([^/?#]*)/i.exec(s);
  if (!m) throw new Error("that doesn't look like a web link (needs http:// or https://)");
  const authority = m[2];
  if (authority.indexOf("@") !== -1) throw new Error("that link isn't supported");
  const hm = /^([^:]*)(?::\d+)?$/.exec(authority);
  const host = ((hm && hm[1]) || "").toLowerCase();
  if (!host || !/^[a-z0-9.-]+$/.test(host)) throw new Error("that link isn't supported");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw new Error("BOON can't fetch a link on this computer's own network");
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ip) {
    const a = Number(ip[1]), b = Number(ip[2]);
    const priv = a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
    if (priv) throw new Error("BOON can't fetch a link on this computer's own network");
  }
  return s;
}

function decodeEntities(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+[0-9]*);/gi, (whole, g) => {
    const low = g.toLowerCase();
    if (named[low] != null) return named[low];
    if (/^#\d+$/.test(g)) return String.fromCodePoint(Number(g.slice(1)));
    if (/^#x[0-9a-f]+$/i.test(g)) return String.fromCodePoint(parseInt(g.slice(2), 16));
    return whole;
  });
}

// Removes every "<open ...> ... <close>" block whose own content is skipped (script/style/comments). A regex
// like /<script>[\s\S]*?<\/script>/g re-tries its lazy middle from every leftover "<script" in the page, which
// is quadratic on a page with many unclosed tags — a crafted or just broken page could hang the Mac helper. This
// scans forward with indexOf instead, each call starting where the last left off, so the whole pass stays O(n)
// however the page is built. An unclosed block drops the rest of the text, same safe default a regex would give.
function stripBlocks(s, pairs) {
  const low = s.toLowerCase();
  let out = "", i = 0;
  while (i < s.length) {
    let bestPos = -1, bestPair = null;
    for (const p of pairs) {
      const pos = low.indexOf(p.open, i);
      if (pos !== -1 && (bestPos === -1 || pos < bestPos)) { bestPos = pos; bestPair = p; }
    }
    if (bestPos === -1) { out += s.slice(i); break; }
    out += s.slice(i, bestPos);
    const closePos = low.indexOf(bestPair.close, bestPos + bestPair.open.length);
    if (closePos === -1) break;
    i = closePos + bestPair.close.length;
  }
  return out;
}
const SKIP_TAGS = ["script", "style", "noscript", "svg", "head"].map((t) => ({ open: "<" + t, close: "</" + t + ">" }));
const COMMENT_PAIR = [{ open: "<!--", close: "-->" }];

function htmlTitle(body) {
  const s = stripBlocks(body.slice(0, 50000), COMMENT_PAIR);
  const low = s.toLowerCase();
  const open = low.indexOf("<title");
  if (open === -1) return "";
  const openEnd = low.indexOf(">", open);
  if (openEnd === -1) return "";
  const close = low.indexOf("</title", openEnd);
  const text = close === -1 ? "" : s.slice(openEnd + 1, close);
  return decodeEntities(text).replace(/\s+/g, " ").trim().slice(0, 200);
}

// Good enough to summarize, not a real reader view: drops scripts/styles/comments, turns block ends into line
// breaks so paragraphs don't run together, then strips every other tag.
function textFromHtml(body) {
  let s = body.slice(0, MAX_BODY);
  s = stripBlocks(s, SKIP_TAGS);
  s = stripBlocks(s, COMMENT_PAIR);
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, " ").replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s.slice(0, MAX_TEXT);
}

// One HTTP request via curl, outside Chrome entirely: headers (via -D) then body (via -o) both land on stdout, in
// that order, so a single string split on the blank line separates them. No -L — redirects are followed by
// fetchFollow() below instead, so every hop gets checkUrl()'d before BOON's robot's request goes anywhere.
function curlOnce(url) {
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  const cmd = "curl -sS --connect-timeout " + CONNECT_TIMEOUT + " --max-time " + FETCH_TIMEOUT +
    " --max-filesize " + MAX_BODY + " -A " + sh(UA) + " -D - -o - " + sh(url);
  let out;
  // Without this, do shell script turns every \n in the output into \r (its default "for AppleScript text" behavior),
  // so the \r\n\r\n / \n\n header/body split below never matches anything — confirmed against the real osascript.
  try { out = app.doShellScript(cmd, { alteringLineEndings: false }); }
  catch (e) {
    const msg = String((e && e.message) || e);
    throw new Error(/time(d)? ?out/i.test(msg) ? "that page took too long to answer" :
      /maximum file size|63\)/i.test(msg) ? "that page was too large for BOON to read" : "couldn't reach that page");
  }
  const sep = out.indexOf("\r\n\r\n");
  const at = sep !== -1 ? sep : out.indexOf("\n\n");
  const head = at !== -1 ? out.slice(0, at) : out;
  const body = at !== -1 ? out.slice(at).replace(/^(\r\n\r\n|\n\n)/, "") : "";
  const statusLine = /^HTTP\/[\d.]+\s+(\d+)/.exec(head);
  const loc = /\n[Ll]ocation:\s*(\S+)/.exec(head);
  return { status: statusLine ? Number(statusLine[1]) : 0, location: loc ? loc[1].trim() : "", body };
}

function fetchFollow(url, hopsLeft) {
  const safe = checkUrl(url);
  const res = curlOnce(safe);
  if (res.status >= 300 && res.status < 400 && res.location) {
    if (hopsLeft <= 0) throw new Error("that page redirects too many times");
    if (!/^https?:\/\//i.test(res.location)) throw new Error("that page redirected somewhere BOON can't follow");
    return fetchFollow(res.location, hopsLeft - 1);
  }
  if (res.status && (res.status < 200 || res.status >= 400)) throw new Error(`that page answered with an error (HTTP ${res.status})`);
  return res;
}

function fetchUrl(req) {
  const url = checkUrl(str(req.url, 2000));
  const res = fetchFollow(url, 3);
  const text = textFromHtml(res.body);
  if (!text) throw new Error("that page had nothing BOON could read");
  return { url, title: htmlTitle(res.body), text, truncated: res.body.length >= MAX_BODY || text.length >= MAX_TEXT };
}

// Pulls out up to `limit` pieces of text found between a literal open/close pair (e.g. "<item>"/"</item>"), left
// to right, each search starting where the last one ended — same linear shape as stripBlocks, for the same reason
// (an XML/RSS feed BOON didn't write is still content from the internet, not something to run a backtracking
// regex over). Unclosed tags just stop the scan early rather than throwing: a partial result beats none.
function extractAll(s, open, close, limit) {
  const low = s.toLowerCase();
  const out = [];
  let i = 0;
  while (out.length < limit) {
    const start = low.indexOf(open, i);
    if (start === -1) break;
    const from = start + open.length;
    const end = low.indexOf(close, from);
    if (end === -1) break;
    out.push(s.slice(from, end));
    i = end + close.length;
  }
  return out;
}
const firstOf = (s, open, close) => extractAll(s, open, close, 1)[0] || "";
function xmlText(s) {
  const m = /^<!\[CDATA\[([\s\S]{0,20000})\]\]>$/.exec(s.trim());
  return decodeEntities(m ? m[1] : s).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

// Bing's search RSS feed (an output format it documents, not a workaround) — DuckDuckGo's HTML endpoint answers
// curl with a "prove you're not a bot" challenge instead of results, and solving that would be the wrong kind of
// clever, so BOON doesn't try. Wikipedia's own search API (JSON, built for this) fills in when Bing has nothing.
function bingSearch(q) {
  const res = fetchFollow("https://www.bing.com/search?q=" + encodeURIComponent(q) + "&format=rss", 3);
  const body = res.body.slice(0, MAX_BODY);
  const results = [];
  for (const item of extractAll(body, "<item>", "</item>", 8)) {
    if (results.length >= 5) break;
    const title = xmlText(firstOf(item, "<title>", "</title>"));
    const url = firstOf(item, "<link>", "</link>").trim();
    const snippet = xmlText(firstOf(item, "<description>", "</description>")).slice(0, 300);
    if (title && url) results.push({ title, url, snippet });
  }
  return results;
}
function wikipediaSearch(q) {
  const res = fetchFollow("https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=" + encodeURIComponent(q), 3);
  let data;
  try { data = JSON.parse(res.body); } catch (e) { return []; }
  const hits = (data && data.query && data.query.search) || [];
  return hits.filter((h) => h && h.title).map((h) => ({
    title: decodeEntities(String(h.title)).trim(),
    url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(String(h.title).replace(/ /g, "_")),
    snippet: decodeEntities(String(h.snippet || "")).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
  }));
}
// Bing's RSS feed, hit without a real browser's cookies/session, turned out (confirmed live, not guessed) to rank
// mostly on the query's first word — "next SAT test date" came back "Next fashion", "Next.js"; "Seoul Foreign
// School" came back only "seoul.go.kr". This requires at least half the query's real words (4+ letters, so
// "the"/"and" don't count) to show up, matched by token prefix rather than a raw substring so a short word can't
// false-positive inside an unrelated longer one ("test" is NOT inside "latest" here, since "latest" doesn't
// start with "test" — a plain .includes() would have wrongly counted it).
function relevant(q, result) {
  const words = q.toLowerCase().split(/\W+/).filter((w) => w.length >= 4);
  if (!words.length) return true;
  const textWords = (result.title + " " + result.snippet).toLowerCase().split(/\W+/).filter(Boolean);
  const hits = words.filter((w) => textWords.some((t) => t.startsWith(w) || w.startsWith(t))).length;
  return hits >= Math.ceil(words.length / 2);
}
function webSearch(req) {
  const q = str(req.query, 300);
  let bing = [];
  try { bing = bingSearch(q).filter((r) => relevant(q, r)); } catch (e) {}
  let wiki = [];
  try { wiki = wikipediaSearch(q); } catch (e) {}
  // Wikipedia's own search always returns its best 5 guesses, even once the real matches run out, so once Bing's
  // bad results are filtered out it was these loose tail entries ("Starship flight test 13" for "next SAT test
  // date") doing the same first-word-ish guessing that got Bing filtered in the first place. Filter Wikipedia the
  // same way; keep its raw #1 if filtering would otherwise leave nothing, since that single top hit has been right
  // in every real example seen so far.
  const wikiGood = wiki.filter((r) => relevant(q, r));
  const wikiKept = wikiGood.length ? wikiGood : wiki.slice(0, 1);
  const seen = new Set();
  const results = [];
  for (const r of [...wikiKept, ...bing]) {
    const key = r.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(r);
    if (results.length >= 5) break;
  }
  if (!results.length) throw new Error("no results for that search");
  return { query: q, results };
}

function createReminder(req) {
  const title = str(req.title, 200);
  const due = when(req.due);
  const Reminders = Application("Reminders");
  const named = req.list ? str(req.list, 60) : "";
  const list = named && Reminders.lists.whose({ name: named })().length ? Reminders.lists.whose({ name: named })()[0] : Reminders.defaultList();
  list.reminders.push(Reminders.Reminder({ name: title, dueDate: due }));
  return { title, due: due.toISOString() };
}

// Marks a reminder done rather than deleting it outright — reversible (Reminders still shows it, under
// Completed), and "turn the alarm off" only needs it to stop alerting, not to vanish from history.
function completeReminder(req) {
  const text = str(req.text, 200).toLowerCase();
  const Reminders = Application("Reminders");
  const named = req.list ? str(req.list, 60) : "";
  const lists = named && Reminders.lists.whose({ name: named })().length ? Reminders.lists.whose({ name: named })() : Reminders.lists();
  const hits = [];
  for (const list of lists) {
    for (const r of list.reminders.whose({ completed: false })()) {
      if (r.name().toLowerCase().includes(text)) hits.push(r);
    }
  }
  if (!hits.length) throw new Error(`no open Mac reminder matches "${req.text}"`);
  if (hits.length > 1) throw new Error(`${hits.length} Mac reminders match "${req.text}" — say more of the title to pick one`);
  const r = hits[0];
  const title = r.name();
  r.completed = true;
  return { title };
}

function createEvent(req) {
  const title = str(req.title, 200);
  const start = when(req.start);
  const end = req.end ? when(req.end) : new Date(start.getTime() + 30 * 60000);
  const Calendar = Application("Calendar");
  const named = req.calendar ? str(req.calendar, 60) : "";
  const cals = Calendar.calendars;
  const cal = named && cals.whose({ name: named })().length ? cals.whose({ name: named })()[0] : cals()[0];
  if (!cal) throw new Error("no Calendar found to add it to");
  cal.events.push(Calendar.Event({ summary: title, startDate: start, endDate: end }));
  return { title, start: start.toISOString(), end: end.toISOString() };
}

function openApp(req) {
  const app = str(req.app, 40);
  const match = APPS.find((a) => a.toLowerCase() === app.toLowerCase());
  if (!match) throw new Error(`BOON can only open: ${APPS.join(", ")}`);
  Application(match).activate();
  return { app: match };
}

// ----- browser control (Day 6) -----
// A Chrome window BOON's robot drives on its own, separate from whatever tab the user is reading. Each window is
// addressed by Chrome's own per-window id (stable for that window's lifetime), handed back from browser_open and
// passed into every later call — nothing is kept in memory here between calls, since each dispatch() runs in its
// own fresh osascript process.
const BROWSER_LOAD_TIMEOUT = 10; // seconds to wait for a navigation to finish before reading/screenshotting anyway
const SHOT_MAX_DIM = 1280;       // longest side a screenshot is resized to, so the base64 JPEG comfortably clears
                                  // native messaging's ~1MB host-to-extension message limit
const SHOT_QUALITY = 60;

function stdApp() {
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  return app;
}

function findBrowserWindow(windowId) {
  const id = Number(windowId);
  if (!Number.isFinite(id)) throw new Error("missing window_id");
  const windows = Application("Google Chrome").windows();
  for (const w of windows) { if (w.id() === id) return w; }
  throw new Error("that browser window isn't open anymore — open a new one with browser_open");
}
// Chrome's own idiom (see open-boon.js) is "active tab index", a 1-based position into the window's tab list,
// not a direct "active tab" property.
function activeTab(win) {
  return win.tabs()[win.activeTabIndex() - 1];
}
function safeTitle(tab) {
  try { return String(tab.title() || "").trim().slice(0, 200); } catch (e) { return ""; }
}
function waitForLoad(app, tab) {
  const deadline = Date.now() + BROWSER_LOAD_TIMEOUT * 1000;
  while (Date.now() < deadline) {
    let loading;
    try { loading = tab.loading(); } catch (e) { return; }
    if (!loading) return;
    app.delay(0.3);
  }
}
// Chrome's window "bounds" can come back either as {x,y,width,height} or as an AppleScript-style
// [left,top,right,bottom] rectangle depending on how the dictionary reports it — handle both.
function winRect(win) {
  const b = win.bounds();
  if (Array.isArray(b)) { const x = b[0], y = b[1]; return { x, y, w: b[2] - x, h: b[3] - y }; }
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}
function execJs(tab, js) {
  try { return tab.execute({ javascript: js }); }
  catch (e) {
    throw new Error(`couldn't read that page's content (${String((e && e.message) || e)}). If this keeps happening, ` +
      `turn on Chrome's View menu → Developer → "Allow JavaScript from Apple Events".`);
  }
}
function captureWindowImage(app, rect) {
  const base = "/tmp/boon-shot-" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
  const png = base + ".png", jpg = base + ".jpg";
  try {
    const region = `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(Math.max(1, rect.w))},${Math.round(Math.max(1, rect.h))}`;
    app.doShellScript("screencapture -x -R" + region + " " + sh(png));
    app.doShellScript(`sips -Z ${SHOT_MAX_DIM} -s format jpeg -s formatOptions ${SHOT_QUALITY} ${sh(png)} --out ${sh(jpg)} >/dev/null 2>&1`);
    const b64 = app.doShellScript("base64 -i " + sh(jpg), { alteringLineEndings: false }).replace(/\s+/g, "");
    if (!b64) throw new Error("empty screenshot");
    return "data:image/jpeg;base64," + b64;
  } catch (e) {
    throw new Error("couldn't take a screenshot of that window");
  } finally {
    try { app.doShellScript("rm -f " + sh(png) + " " + sh(jpg)); } catch (e) {}
  }
}

function browserOpen(req) {
  const url = checkUrl(str(req.url, 2000));
  const Chrome = Application("Google Chrome");
  Chrome.activate();
  const win = Chrome.Window({});
  Chrome.windows.push(win);
  const tab = win.tabs[0];
  tab.url = url;
  win.index = 1;
  waitForLoad(stdApp(), tab);
  return { window_id: win.id(), url, title: safeTitle(tab) };
}
function browserNavigate(req) {
  const win = findBrowserWindow(req.window_id);
  const url = checkUrl(str(req.url, 2000));
  const tab = activeTab(win);
  tab.url = url;
  win.index = 1;
  waitForLoad(stdApp(), tab);
  return { window_id: Number(req.window_id), url, title: safeTitle(tab) };
}
function browserRead(req) {
  const win = findBrowserWindow(req.window_id);
  const tab = activeTab(win);
  const text = execJs(tab, "document.body ? document.body.innerText : ''");
  const clean = String(text || "").replace(/[ \t]+/g, " ").replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) throw new Error("that page had nothing BOON could read");
  return { window_id: Number(req.window_id), url: tab.url(), title: safeTitle(tab), text: clean.slice(0, MAX_TEXT), truncated: clean.length > MAX_TEXT };
}
function browserScreenshot(req) {
  const win = findBrowserWindow(req.window_id);
  const tab = activeTab(win);
  const app = stdApp();
  Application("Google Chrome").activate();
  win.index = 1;
  app.delay(0.2);
  const image = captureWindowImage(app, winRect(win));
  return { window_id: Number(req.window_id), url: tab.url(), title: safeTitle(tab), image };
}

function dispatch(req) {
  if (req.action === "create_reminder") return createReminder(req);
  if (req.action === "complete_reminder") return completeReminder(req);
  if (req.action === "create_event") return createEvent(req);
  if (req.action === "open_app") return openApp(req);
  if (req.action === "web_search") return webSearch(req);
  if (req.action === "fetch_url") return fetchUrl(req);
  if (req.action === "browser_open") return browserOpen(req);
  if (req.action === "browser_navigate") return browserNavigate(req);
  if (req.action === "browser_read") return browserRead(req);
  if (req.action === "browser_screenshot") return browserScreenshot(req);
  throw new Error(`no such action: ${req.action}`);
}

function run(argv) {
  let req, id = null;
  try { req = JSON.parse(argv[0]); id = req.id ?? null; }
  catch (e) { return JSON.stringify({ id, ok: false, error: "the request wasn't valid JSON" }); }
  try { return JSON.stringify(Object.assign({ id, ok: true }, dispatch(req))); }
  catch (e) { return JSON.stringify({ id, ok: false, error: String((e && e.message) || e) }); }
}

// A Node test can require() this file and call dispatch() with its own stand-in Application(), without osascript.
if (typeof module !== "undefined") module.exports = { dispatch, run, APPS, checkUrl, textFromHtml, decodeEntities, htmlTitle, extractAll, xmlText, relevant, createReminder, completeReminder, winRect };
