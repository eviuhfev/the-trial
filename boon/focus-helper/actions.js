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
const MAX_BODY = 3000000;  // bytes of response read before BOON's robot sees any of it
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

// Finds `open` (e.g. "<head"), skipping a match that's really a prefix of a longer tag name — "<head" must not
// match inside "<header". Only checked when open ends in a word character (a tag name): the char right after then
// has to be '>', '/', whitespace or end of string, or it's a different, longer name and the scan keeps going.
// A non-word-ending open like "<!--" (HTML comments) has no such longer-name ambiguity, so it matches as-is.
function indexOfTag(low, open, from) {
  const checkBoundary = /\w$/.test(open);
  for (let i = from; ; ) {
    const pos = low.indexOf(open, i);
    if (pos === -1 || !checkBoundary) return pos;
    const next = low[pos + open.length];
    if (next === undefined || next === ">" || next === "/" || /\s/.test(next)) return pos;
    i = pos + 1;
  }
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
      const pos = indexOfTag(low, p.open, i);
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

// Removes every "<...>" tag, aware that a quoted attribute can itself contain a literal '>' — seen for real in
// Wikipedia's data-mw template-JSON attributes, where a naive /<[^>]+>/ stops at that inner '>' and leaks the
// rest of the attribute (raw template JSON) as page text. Scans forward with indexOf instead of a backtracking
// regex, same reason as stripBlocks above: a page with many unclosed '<' must stay O(n), not risk blowing up
// hunting for a '>' that never comes. An unclosed tag drops the rest, same safe default stripBlocks uses.
function stripTags(s) {
  let out = "", i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt === -1) { out += s.slice(i); break; }
    out += s.slice(i, lt);
    let j = lt + 1, gt = -1;
    while (j < s.length) {
      const c = s[j];
      if (c === '"' || c === "'") {
        const end = s.indexOf(c, j + 1);
        j = end === -1 ? s.length : end + 1;
        continue;
      }
      if (c === ">") { gt = j; break; }
      j++;
    }
    if (gt === -1) { i = s.length; break; }
    out += " ";
    i = gt + 1;
  }
  return out;
}
const SKIP_TAGS = ["script", "style", "noscript", "svg", "head", "nav", "header", "footer", "aside"].map((t) => ({ open: "<" + t, close: "</" + t + ">" }));
const COMMENT_PAIR = [{ open: "<!--", close: "-->" }];

// Content between one tag's own '>' and its properly nested matching close, counting opens/closes of that same
// tag name by position so an inner one (e.g. a nested <div> inside a content div) doesn't end the region early.
// tagStart is the position of that tag's own '<'; returns "" if it's not a real tag there or never closes.
function extractByDepth(s, low, tagName, tagStart) {
  if (tagStart === -1) return "";
  const openEnd = low.indexOf(">", tagStart);
  if (openEnd === -1) return "";
  const openMarker = "<" + tagName, closeMarker = "</" + tagName;
  let depth = 1, i = openEnd + 1;
  while (depth > 0) {
    const nextClose = low.indexOf(closeMarker, i);
    if (nextClose === -1) return s.slice(openEnd + 1);
    const nextOpen = indexOfTag(low, openMarker, i);
    if (nextOpen !== -1 && nextOpen < nextClose) { depth++; i = nextOpen + openMarker.length; }
    else { depth--; if (depth === 0) return s.slice(openEnd + 1, nextClose); i = nextClose + closeMarker.length; }
  }
}

// Narrows the page to its main-content landmark before anything else runs, so nav/sidebar/menu text never
// reaches the summarizer to begin with — a real Wikipedia fetch buried its lead paragraph behind ~4800 chars of
// site-chrome nav otherwise, blowing the whole MAX_TEXT budget on menus. Tries a <main> or <article> tag first
// (singleton landmarks, so a first match is always the real one), then an id="mw-content-text" (Wikipedia's own
// content div), id="bodycontent" or role="main" marker, each depth-matched since those sit on a <div>. Returns
// "" if none are found, so the caller falls back to the whole page — no change for pages without any of these.
function extractMainRegion(s, low) {
  for (const tag of ["main", "article"]) {
    const region = extractByDepth(s, low, tag, indexOfTag(low, "<" + tag, 0));
    if (region) return region;
  }
  for (const marker of ['id="mw-content-text"', 'id="bodycontent"', 'role="main"']) {
    const markPos = low.indexOf(marker);
    if (markPos === -1) continue;
    const tagStart = low.lastIndexOf("<", markPos);
    const nameMatch = tagStart === -1 ? null : /^<([a-z0-9]+)/.exec(low.slice(tagStart, tagStart + 20));
    if (!nameMatch) continue;
    const region = extractByDepth(s, low, nameMatch[1], tagStart);
    if (region) return region;
  }
  return "";
}

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

// Good enough to summarize, not a real reader view: narrows to the main-content landmark if there is one, drops
// scripts/styles/comments/nav chrome, turns block ends into line breaks so paragraphs don't run together, then
// strips every other tag.
function textFromHtml(body) {
  let s = body.slice(0, MAX_BODY);
  const main = extractMainRegion(s, s.toLowerCase());
  if (main) s = main;
  s = stripBlocks(s, SKIP_TAGS);
  s = stripBlocks(s, COMMENT_PAIR);
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = stripTags(s);
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

// ----- browser control (Day 6-7) -----
// A browser window BOON's robot drives on its own, separate from whatever tab the user is reading — entirely
// through browser-driver.js (a small Node/Playwright script install.sh copies alongside this file). It drives
// an isolated Chromium instance over the DevTools protocol, never through Apple Events: a second process of
// the user's REAL Chrome (however it's launched) makes Apple Events address either one unpredictably, which
// would break boon/desktop-icon/open-boon.js's own Chrome-finding script — a feature this one must not touch.
// Chromium is a different application entirely, so it can run alongside the user's real Chrome with no such
// conflict. See browser-driver.js itself for the rest of the design (profile isolation, the risk re-check
// right before a click/keystroke, why it's Playwright's own managed browser and not the user's Chrome).
function runBrowserDriver(req) {
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  const driver = "$HOME/Library/Application Support/BOON Focus/run-browser-driver.sh";
  let out;
  // sh() single-quotes, which would stop $HOME from expanding (confirmed live: single quotes made this a
  // literal, nonexistent path) — double quotes instead, which still protect the spaces in the path.
  try { out = app.doShellScript('"' + driver + '" ' + sh(JSON.stringify(req)), { alteringLineEndings: false }); }
  catch (e) { throw new Error(`browser control failed (${String((e && e.message) || e)})`); }
  let result;
  try { result = JSON.parse(out); }
  catch (e) { throw new Error("browser control returned something unreadable"); }
  if (!result.ok) throw new Error(result.error || "browser control failed");
  delete result.ok;
  return result;
}

function dispatch(req) {
  if (req.action === "create_reminder") return createReminder(req);
  if (req.action === "complete_reminder") return completeReminder(req);
  if (req.action === "create_event") return createEvent(req);
  if (req.action === "open_app") return openApp(req);
  if (req.action === "web_search") return webSearch(req);
  if (req.action === "fetch_url") return fetchUrl(req);
  if (String(req.action || "").indexOf("browser_") === 0) return runBrowserDriver(req);
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
if (typeof module !== "undefined") module.exports = { dispatch, run, APPS, checkUrl, textFromHtml, decodeEntities, htmlTitle, extractAll, xmlText, relevant, createReminder, completeReminder };
