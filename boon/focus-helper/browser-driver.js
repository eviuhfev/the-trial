#!/usr/bin/env node
// BOON's browser control (Day 6-7): drives an isolated, visible Chromium window over the Chrome DevTools
// Protocol, via Playwright, from actions.js's browser_* dispatch (see the "browser control" section there).
// Deliberately Playwright's OWN managed Chromium, not the user's real Google Chrome: a second process of
// that same app — however it's launched — makes Apple Events address either one unpredictably (confirmed
// live, 2026-10-03: the user's real window vanished from `Application("Google Chrome")` while a second
// instance ran), which would have broken boon/desktop-icon/open-boon.js's own Chrome-finding script, a
// feature this one must not touch. Chromium is a different application entirely, so it can run alongside the
// user's real Chrome with no such conflict, and this script never uses Apple Events at all.
// Each call from actions.js is a fresh, stateless process (its own osascript-per-call convention): this script
// launches Chromium once, detached so it outlives this process, and every later call reconnects over CDP.
//   node browser-driver.js '<request JSON>'   runs one action, prints its result as JSON
"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

const PORT = 9876;
const PROFILE_DIR = path.join(os.homedir(), "Library", "Application Support", "BOON Browser");
const VIEWPORT = { width: 1280, height: 800 };
const LOAD_TIMEOUT = 10000; // ms to wait for Chromium/CDP to come up, or a navigation to finish, before acting anyway
const MAX_TEXT = 6000;      // chars of page text handed back (keeps prompts small, matches actions.js's own limit)

function str(v, max) {
  const s = String(v == null ? "" : v).trim().slice(0, max);
  if (!s) throw new Error("missing text");
  return s;
}

// Same rule as actions.js's own checkUrl — duplicated rather than shared, since this is a separate Node
// process from actions.js's own JXA scope. Keep in sync if either changes.
function checkUrl(raw) {
  const s = String(raw == null ? "" : raw).trim().slice(0, 2000);
  const m = /^(https?):\/\/([^/?#]*)/i.exec(s);
  if (!m) throw new Error("that doesn't look like a web link (needs http:// or https://)");
  const authority = m[2];
  if (authority.indexOf("@") !== -1) throw new Error("that link isn't supported");
  const hm = /^([^:]*)(?::\d+)?$/.exec(authority);
  const host = ((hm && hm[1]) || "").toLowerCase();
  if (!host || !/^[a-z0-9.-]+$/.test(host)) throw new Error("that link isn't supported");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw new Error("BOON can't open a link on this computer's own network");
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ip) {
    const a = Number(ip[1]), b = Number(ip[2]);
    const priv = a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
    if (priv) throw new Error("BOON can't open a link on this computer's own network");
  }
  return s;
}

// Defense in depth with index.html's own lookRisky() — this is the Mac helper's own copy of the same check,
// re-applied right before a real click/keystroke fires, so a bug or bypass upstream still can't reach a
// submit/pay/send/sign-in-shaped target. Keep in sync with index.html's RISKY_WORDS if either changes.
const RISKY_WORDS = /\b(submit|pay(?:ment)?s?|buy|purchase|checkout|place\s*order|order\s*now|send|sign[\s-]?in|sign[\s-]?up|log[\s-]?in|log[\s-]?out|confirm|subscribe|delete|remove|transfer|donate|agree|accept)\b/i;
function riskyElement(el) {
  if (!el) return "";
  const text = [el.text, el.buttonText].filter(Boolean).join(" ").trim();
  if (RISKY_WORDS.test(text)) return text.slice(0, 60) || "that";
  if (el.type === "password" || /current-password|new-password/i.test(el.autocomplete || "")) return "a password field";
  return "";
}

async function alreadyRunning() {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1000);
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: ac.signal });
    clearTimeout(t);
    return res.ok;
  } catch (e) { return false; }
}

// --password-store=basic: without it, Chromium tries macOS Keychain for its own password manager, which can
// surface an unexpected permission dialog that would silently hang unattended automation. Headful (no
// --headless) on purpose: BOON's agent work is meant to be visible, same as its Allow/Deny cards and action log.
function launchChromium() {
  const bin = chromium.executablePath();
  if (!fs.existsSync(bin)) throw new Error("BOON's browser isn't installed yet — run install.sh again");
  const child = spawn(bin, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    // Without this, a Retina screen's 2x device pixel ratio makes the screenshot twice the size the viewport
    // and click coordinates use (confirmed live: a 1280x800 viewport produced a 2560x1600 image) — forcing it
    // to 1 keeps "image pixels == click pixels" exactly true, at the cost of the visible window looking a
    // little less crisp on a Retina display.
    "--force-device-scale-factor=1",
  ], { detached: true, stdio: "ignore" });
  child.unref();
}

async function waitForCdp(deadline) {
  while (Date.now() < deadline) {
    if (await alreadyRunning()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("BOON's browser didn't start in time");
}

async function connect() {
  if (!(await alreadyRunning())) {
    launchChromium();
    await waitForCdp(Date.now() + LOAD_TIMEOUT);
  }
  return chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
}

// Page/"window" identity across separate stateless process invocations, since nothing is kept in memory here
// between calls — each dispatch runs in its own fresh node process, same as actions.js's own osascript calls.
async function findPage(browser, windowId) {
  const ctx = browser.contexts()[0];
  const marker = "boon-" + windowId;
  for (const page of ctx.pages()) {
    const name = await page.evaluate(() => window.name).catch(() => null);
    if (name === marker) return page;
  }
  throw new Error("that browser window isn't open anymore — open a new one with browser_open");
}

async function newWindow(browser, url) {
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  await page.setViewportSize(VIEWPORT);
  const windowId = Date.now();
  await page.evaluate((n) => { window.name = n; }, "boon-" + windowId);
  await page.goto(url, { timeout: LOAD_TIMEOUT, waitUntil: "domcontentloaded" }).catch(() => {});
  return { page, windowId };
}

async function readText(page) {
  const text = await page.evaluate(() => (document.body ? document.body.innerText : ""));
  return String(text || "").replace(/[ \t]+/g, " ").replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// (x, y) are viewport CSS pixels — the SAME space page.mouse.click uses — so what's inspected here and what
// later gets clicked are always the same element. No screen/viewport conversion, unlike the old JXA version:
// CDP's input events and document.elementFromPoint share one coordinate space by construction.
async function inspectAt(page, x, y) {
  return page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const form = el.closest ? el.closest("form") : null;
    const a = el.closest ? el.closest("a") : null;
    const btn = el.closest ? el.closest('button, [role="button"], input[type="submit"], input[type="button"]') : null;
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName ? el.tagName.toLowerCase() : "",
      type: (el.getAttribute && el.getAttribute("type")) || "",
      autocomplete: (el.getAttribute && el.getAttribute("autocomplete")) || "",
      text: String((el.innerText || el.value || (el.getAttribute && el.getAttribute("aria-label")) || el.title || "")).slice(0, 100),
      href: a ? String(a.href || "") : "",
      formAction: form ? String(form.getAttribute("action") || "") : "",
      buttonText: btn ? String((btn.innerText || btn.value || (btn.getAttribute && btn.getAttribute("aria-label")) || "")).slice(0, 100) : "",
      click_x: Math.round(r.left + r.width / 2),
      click_y: Math.round(r.top + r.height / 2),
      in_window: r.width > 0 && r.height > 0,
    };
  }, { x, y });
}

function clampToViewport(x, y) {
  if (x < 0 || x > VIEWPORT.width || y < 0 || y > VIEWPORT.height) throw new Error("refused: that point is outside the browser window");
}

// Both click_at and type_at re-inspect and re-check risk themselves, right before acting, rather than trusting
// that index.html's own check (against a possibly different point) already covered it — the actual last line
// able to refuse before a real click/keystroke fires.
async function run(req) {
  const browser = await connect();
  try {
    if (req.action === "browser_open") {
      const url = checkUrl(str(req.url, 2000));
      const { page, windowId } = await newWindow(browser, url);
      return { window_id: windowId, url, title: await page.title() };
    }
    const windowId = Number(req.window_id);
    if (!Number.isFinite(windowId)) throw new Error("missing window_id");
    const page = await findPage(browser, windowId);

    if (req.action === "browser_navigate") {
      const url = checkUrl(str(req.url, 2000));
      await page.goto(url, { timeout: LOAD_TIMEOUT, waitUntil: "domcontentloaded" }).catch(() => {});
      return { window_id: windowId, url, title: await page.title() };
    }
    if (req.action === "browser_read") {
      const text = await readText(page);
      if (!text) throw new Error("that page had nothing BOON could read");
      return { window_id: windowId, url: page.url(), title: await page.title(), text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT };
    }
    if (req.action === "browser_screenshot") {
      const buf = await page.screenshot({ type: "jpeg", quality: 70 });
      return { window_id: windowId, url: page.url(), title: await page.title(), image: "data:image/jpeg;base64," + buf.toString("base64"), image_w: VIEWPORT.width, image_h: VIEWPORT.height };
    }
    if (req.action === "browser_inspect_point") {
      const x = Number(req.x), y = Number(req.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("missing x/y");
      return { window_id: windowId, x, y, element: await inspectAt(page, x, y) };
    }
    if (req.action === "browser_click_at") {
      const x = Math.round(Number(req.x)), y = Math.round(Number(req.y));
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("missing x/y");
      clampToViewport(x, y);
      const risk = riskyElement(await inspectAt(page, x, y));
      if (risk) throw new Error(`refused: that looks like ${risk} — BOON won't click submit/pay/buy/send/sign-in/log-in/delete-shaped targets`);
      await page.bringToFront();
      await page.mouse.click(x, y);
      return { window_id: windowId, x, y };
    }
    if (req.action === "browser_type_at") {
      const x = Math.round(Number(req.x)), y = Math.round(Number(req.y));
      const text = str(req.text, 2000);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("missing x/y");
      // A \r or \n in the text is Return to a focused field — that would submit a form behind the risk check
      // above, not through it, so it's refused outright rather than stripped (stripping could silently change
      // what's typed).
      if (/[\r\n]/.test(text)) throw new Error("refused: that text contains a newline, which would press Return and could submit a form — type the text alone, without a line break");
      clampToViewport(x, y);
      const risk = riskyElement(await inspectAt(page, x, y));
      if (risk) throw new Error(`refused: that looks like ${risk} — BOON won't type into it`);
      await page.bringToFront();
      // Triple-click selects any text already in the field, so typing replaces it instead of appending
      // (confirmed live: a plain click left the cursor in place and a second type ran on into the first).
      await page.mouse.click(x, y, { clickCount: 3 });
      await page.keyboard.type(text);
      return { window_id: windowId, x, y, typed: text.length };
    }
    throw new Error(`no such action: ${req.action}`);
  } finally {
    // Disconnects this script's own CDP session only — Chromium itself (and the user's other browser_*
    // windows) keeps running, since it was launched detached rather than owned by this process.
    await browser.close().catch(() => {});
  }
}

async function main() {
  let req;
  try { req = JSON.parse(process.argv[2]); }
  catch (e) { console.log(JSON.stringify({ ok: false, error: "the request wasn't valid JSON" })); return; }
  try {
    const result = await run(req);
    console.log(JSON.stringify(Object.assign({ ok: true }, result)));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
  }
}

main();
