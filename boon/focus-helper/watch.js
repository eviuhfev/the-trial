#!/usr/bin/osascript -l JavaScript
// BOON Focus helper: during a focus session, any other Mac app that comes to the front is hidden at once (hidden,
// never quit, so nothing in it is lost) and Chrome is brought back. Chrome starts it through boon-focus-host.
// It stops when the session's time is up, when boon-focus-host is gone (focus ended, the add-on was turned off or
// reloaded, or Chrome quit), when Chrome isn't running, when the add-on stops checking in (Chrome froze), and if
// Chrome won't come back to the front, so it can never trap the Mac.
//   osascript -l JavaScript watch.js <end, ms since 1970> <host pid> <check-in file>   run until then
//   osascript -l JavaScript watch.js dry <end> <host pid> <check-in file>   the same, but only logs what it would do
//   osascript -l JavaScript watch.js probe [seconds]                   print what it sees each second; hides nothing
ObjC.import("AppKit");

const CHROME = "com.google.Chrome";
const TICK_S = 0.05;                  // how often it looks at the front app, in seconds
const MAX_MS = 181 * 60000;           // a focus session is at most 3 hours
const HIDE_EVERY_MS = 100;            // asking the same app again, if it came straight back
const OPEN_AFTER_MS = 250, OPEN_EVERY_MS = 1000;   // when asking Chrome nicely hasn't brought it back
const CHECK_EVERY_MS = 2000;          // is the host still there, is Chrome still running
const GIVE_UP_MS = 15000;             // another app stayed in front this long: stop and leave the Mac alone
const QUIET_MS = 30000;               // the add-on checks in every 10 s; this long without one means Chrome froze
const SLEPT_MS = 5000;                // a gap this long between looks means the Mac was asleep
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

function isIntruder(app) {
  if (none(app)) return false;
  const id = idOf(app);
  return id !== CHROME && !NEVER.has(id) && app.activationPolicy === REGULAR;
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

// macOS may turn down an app's request to come forward while the student is in another app, so this asks in the
// newer way (from the app in front), then the older way; openChrome() below is the fallback that always works.
function askChrome(chrome, from) {
  try { if (chrome.activateFromApplicationOptions(from, 0)) return; } catch (e) {}
  try { chrome.activateWithOptions(2); } catch (e) {}
}
// Like clicking Chrome in the Dock. Chrome shows the window it had (the work, in full screen).
const openChrome = () => sh("/usr/bin/open", ["-b", CHROME]);

function watch(until, host, beatFile, dry) {
  say(`on until ${new Date(until).toISOString()}${dry ? " (dry run: hides nothing)" : ""}`);
  let chrome = chromeApp(), checked = Date.now(), last = Date.now();
  let beat = touchedAt(beatFile), heard = Date.now();
  let awaySince = 0, hidPid = 0, hidAt = 0, openedAt = 0;
  while (Date.now() < until) {
    wait(TICK_S);
    const now = Date.now();
    // After the Mac wakes up, give Chrome time to check in again, and start counting afresh.
    if (now - last > SLEPT_MS) { heard = now; awaySince = 0; }
    last = now;
    if (now - checked >= CHECK_EVERY_MS) {
      checked = now;
      if (!alive(host)) return "off: focus ended";
      chrome = chromeApp();
      if (beatFile) {
        const b = touchedAt(beatFile);
        if (b && b !== beat) { beat = b; heard = now; }
        if (now - heard > QUIET_MS) return "off: Chrome stopped checking in";
      }
    }
    if (!chrome) return "off: Chrome isn't running";
    const front = ws.frontmostApplication;
    if (!isIntruder(front)) { awaySince = 0; hidPid = 0; continue; }
    if (!awaySince) { awaySince = now; say(`${dry ? "would hide" : "hid"} ${nameOf(front)}`); }
    if (!dry && now - awaySince > GIVE_UP_MS) return `off: ${nameOf(front)} stayed in front and Chrome didn't come back`;
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
