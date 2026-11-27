#!/usr/bin/osascript -l JavaScript
// BOON Focus helper: during a focus session, any other Mac app that comes to the front is hidden at once (hidden,
// never quit, so nothing in it is lost) and Chrome is brought back. Chrome starts it through boon-focus-host.
// It stops when the session's time is up, when boon-focus-host is gone (focus ended, the add-on was turned off or
// reloaded, or Chrome quit) and when Chrome isn't running. It pauses (hides nothing) while the add-on isn't checking
// in (Chrome froze) and after Chrome hasn't come back for 15 s, until Chrome is in front again, so it can never trap
// the Mac.
//   osascript -l JavaScript watch.js <end, ms since 1970> <host pid> <check-in file>   run until then
//   osascript -l JavaScript watch.js dry <end> <host pid> <check-in file>   the same, but only logs what it would do
//   osascript -l JavaScript watch.js probe [seconds]                   print what it sees each second; hides nothing
ObjC.import("AppKit");

const CHROME = "com.google.Chrome";
const TICK_S = 0.05;                  // how often it looks at the front app, in seconds
const MAX_MS = 181 * 60000;           // a focus session is at most 3 hours
const HIDE_EVERY_MS = 100;            // asking the same app again, if it came straight back
const OPEN_AFTER_MS = 100, OPEN_EVERY_MS = 1000;   // when hiding and asking Chrome nicely haven't brought it back
const CHECK_EVERY_MS = 2000;          // is the host still there, is Chrome still running
const GIVE_UP_MS = 15000;             // other apps stayed in front this long: leave the Mac alone until Chrome is back
const QUIET_MS = 30000;               // the add-on checks in every 10 s; this long without one means Chrome froze
const SLEPT_MS = 5000;                // a look that took this long means the Mac was asleep
// Never hidden: password, Touch ID and permission prompts, the login window and Force Quit (loginwindow), system
// alerts, screenshots, the screen saver, System Settings, and the Dock, Spotlight and other parts of macOS.
const NEVER = new Set([
  "com.apple.loginwindow", "com.apple.SecurityAgent", "com.apple.coreautha", "com.apple.LocalAuthentication.UIAgent",
  "com.apple.UserNotificationCenter", "com.apple.CoreServicesUIAgent", "com.apple.systempreferences",
  "com.apple.ScreenSaver.Engine", "com.apple.screencaptureui", "com.apple.dock", "com.apple.Spotlight",
  "com.apple.controlcenter", "com.apple.notificationcenterui", "com.apple.WindowManager",
  "com.apple.accessibility.universalAccessAuthWarn",
]);
const REGULAR = 0;                    // NSApplicationActivationPolicyRegular: an app with a Dock icon and windows

const ws = $.NSWorkspace.sharedWorkspace;
const say = (text) => console.log(`${new Date().toISOString()} ${text}`);
const none = (app) => !app || app.isNil();
const idOf = (app) => (none(app) ? "" : ObjC.unwrap(app.bundleIdentifier) || "");
const nameOf = (app) => (none(app) ? "?" : ObjC.unwrap(app.localizedName) || idOf(app) || "an app");
// Pumping the run loop is what keeps macOS's idea of the front app up to date in this process.
const wait = (seconds) => $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(seconds));

// Chrome itself, or a site installed as a Chrome app (its windows are Chrome's, and the add-on locks them).
const isChrome = (id) => id === CHROME || id.startsWith(CHROME + ".app.");
function isIntruder(app) {
  if (none(app)) return false;
  const id = idOf(app);
  return !isChrome(id) && !NEVER.has(id) && app.activationPolicy === REGULAR;
}

function chromeApp() {
  const list = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(CHROME);
  return list.count ? list.objectAtIndex(0) : null;
}

// Runs a command and returns its exit status (-1 if it couldn't start).
function sh(path, args) {
  try {
    const task = $.NSTask.alloc.init;
    task.launchPath = path;
    task.arguments = $(args);
    task.standardOutput = $.NSFileHandle.fileHandleWithNullDevice;
    task.standardError = $.NSFileHandle.fileHandleWithNullDevice;
    task.launch;
    task.waitUntilExit;
    return task.terminationStatus;
  } catch (e) {
    return -1;
  }
}
// kill -0 only checks the process is there; it sends nothing. If the check itself fails, assume it's there.
const alive = (pid) => !pid || sh("/bin/kill", ["-0", String(pid)]) !== 1;
// When boon-focus-host last touched the check-in file (0 if it can't be read).
function touchedAt(path) {
  try {
    const attrs = $.NSFileManager.defaultManager.attributesOfItemAtPathError(path, null);
    const date = none(attrs) ? null : attrs.objectForKey("NSFileModificationDate");
    return none(date) ? 0 : date.timeIntervalSince1970;
  } catch (e) {
    return 0;
  }
}

// Hiding the app in front usually hands the front back to Chrome by itself. macOS may turn down a plain request to
// come forward from here, so this asks in the newer way (from the app in front) and the older way, and
// openChrome() below is the stronger fallback. A hidden Chrome is shown first, so it has a window to come back to.
function askChrome(chrome, from) {
  try { if (chrome.isHidden) chrome.unhide; } catch (e) {}
  try { if (chrome.activateFromApplicationOptions(from, 0)) return; } catch (e) {}
  try { chrome.activateWithOptions(2); } catch (e) {}
}
// Like clicking Chrome in the Dock: Chrome comes forward with the window it had (the work, in full screen).
// It doesn't wait for `open` (macOS 26 can leave it hanging), and never runs two at once.
let opening = null;
function openChrome() {
  try {
    if (opening && opening.isRunning) return;
    const task = $.NSTask.alloc.init;
    task.launchPath = "/usr/bin/open";
    task.arguments = $(["-b", CHROME]);
    task.standardOutput = $.NSFileHandle.fileHandleWithNullDevice;
    task.standardError = $.NSFileHandle.fileHandleWithNullDevice;
    task.launch;
    opening = task;
  } catch (e) {}
}

function watch(until, host, beatFile, dry) {
  say(`on until ${new Date(until).toISOString()}${dry ? " (dry run: hides nothing)" : ""}`);
  let chrome = chromeApp(), checked = Date.now();
  let beat = touchedAt(beatFile), heard = Date.now(), quiet = false, gaveUp = false;
  let awaySince = 0, hidPid = 0, hidAt = 0, openedAt = 0;
  while (Date.now() < until) {
    const before = Date.now();
    wait(TICK_S);
    const now = Date.now();
    if (now >= until) break;
    // The Mac slept (or the clock was set back): give Chrome time to check in again, and count everything afresh.
    if (now - before > SLEPT_MS || now < before) { heard = now; checked = 0; awaySince = 0; hidAt = 0; openedAt = 0; }
    if (now - checked >= CHECK_EVERY_MS) {
      checked = now;
      if (!alive(host)) return "off: focus ended";
      chrome = chromeApp();
      if (beatFile) {
        const b = touchedAt(beatFile);
        if (b && b !== beat) { beat = b; heard = now; }
        if (quiet !== (now - heard > QUIET_MS)) {
          quiet = !quiet;
          say(quiet ? "paused: Chrome stopped checking in" : "on again: Chrome is checking in");
        }
      }
    }
    if (!chrome) return "off: Chrome isn't running";
    const front = ws.frontmostApplication;
    if (!isIntruder(front)) {
      if (awaySince) say(`back to ${nameOf(front)} after ${now - awaySince} ms`);
      if (gaveUp && isChrome(idOf(front))) { gaveUp = false; say("on again: back in Chrome"); }
      awaySince = 0;
      hidPid = 0;
      continue;
    }
    if (quiet || gaveUp) { awaySince = 0; hidPid = 0; continue; }
    if (!awaySince) { awaySince = now; say(`${dry ? "would hide" : "hid"} ${nameOf(front)}`); }
    if (!dry && now - awaySince > GIVE_UP_MS) {
      gaveUp = true;
      say(`paused: ${nameOf(front)} stayed in front and Chrome didn't come back`);
      continue;
    }
    const pid = front.processIdentifier;
    if (dry) continue;
    if (pid !== hidPid || now - hidAt >= HIDE_EVERY_MS) {
      hidPid = pid;
      hidAt = now;
      try { front.hide; } catch (e) {}
      askChrome(chrome, front);
    }
    if (now - awaySince >= OPEN_AFTER_MS && now - openedAt >= OPEN_EVERY_MS) {
      openedAt = now;
      // Only while Chrome is still running: `open` would start it again after the student quit it.
      chrome = chromeApp();
      if (!chrome) return "off: Chrome isn't running";
      openChrome();
    }
  }
  return "off: focus time is over";
}

// For checking the helper on a Mac: shows what it would do, changes nothing.
function probe(seconds) {
  const lines = [];
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    wait(1);
    const front = ws.frontmostApplication;
    const line = `front: ${nameOf(front)} (${idOf(front) || "no id"}, policy ${none(front) ? "-" : front.activationPolicy})` +
      ` -> ${isIntruder(front) ? "would hide it" : "leaves it"}; Chrome ${chromeApp() ? "running" : "not running"}`;
    say(line);
    lines.push(line);
  }
  return lines.join("\n");
}

function run(argv) {
  if (argv[0] === "probe") return probe(Math.max(1, Math.min(120, Number(argv[1]) || 10)));
  const dry = argv[0] === "dry";
  if (dry) argv = argv.slice(1);
  const until = Math.min(Number(argv[0]) || 0, Date.now() + MAX_MS);
  const result = until > Date.now() ? watch(until, Number(argv[1]) || 0, argv[2] || "", dry) : "off: no focus time given";
  say(result);
  return "";
}
