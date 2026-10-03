// BOON's floating desktop icon: a small always-on-top widget, separate from the browser tab, that sits on screen
// and opens BOON (starting its local server if needed) when clicked. See install.sh for how it's kept running
// across restarts.
const { app, BrowserWindow, ipcMain, Menu, screen, globalShortcut, powerMonitor } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn, execFile } = require("child_process");

// A raw TCP/HTTP health check, not a browser navigation, so 127.0.0.1 (the server's actual bind address) is fine
// here even though every browser-facing URL below must be "localhost" to match BOON's existing data origin.
const HEALTHCHECK_URL = "http://127.0.0.1:6999/";
const BOON_URL = "http://localhost:6999/";
const POSITION_FILE = path.join(app.getPath("userData"), "position.json");
const ICON_SIZE = 84;

// install.sh copies this app out of the Desktop-situated git checkout into ~/Library/Application Support (macOS
// guards Desktop/Documents from processes launchd starts, same reason boon/focus-helper isn't run in place
// either), and drops a boon-dir.txt next to the copy pointing back at the live boon/ folder to serve — so the
// server always serves the current, just-pulled code, never a stale copy. Falls back to running in place
// (boon/desktop-icon/main.js) when there's no such config, e.g. testing straight from the repo.
function resolveBoonDir() {
  try {
    const configured = fs.readFileSync(path.join(__dirname, "boon-dir.txt"), "utf8").trim();
    if (configured) return configured;
  } catch (e) {}
  return path.join(__dirname, "..");
}
const BOON_DIR = resolveBoonDir();
const REPO_ROOT = path.join(BOON_DIR, "..");

function loadPosition() {
  try {
    const saved = JSON.parse(fs.readFileSync(POSITION_FILE, "utf8"));
    if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) return saved;
  } catch (e) {}
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  return { x: width - ICON_SIZE - 40, y: height - ICON_SIZE - 40 };
}
function savePosition(win) {
  try {
    const [x, y] = win.getPosition();
    fs.writeFileSync(POSITION_FILE, JSON.stringify({ x, y }));
  } catch (e) {}
}

function boonIsUp() {
  return new Promise((resolve) => {
    const req = http.get(HEALTHCHECK_URL, (res) => { res.resume(); resolve(true); });
    req.on("error", () => resolve(false));
    req.setTimeout(800, () => { req.destroy(); resolve(false); });
  });
}
function startBoonServer() {
  const server = spawn("python3", ["-m", "http.server", "6999", "--bind", "127.0.0.1", "--directory", BOON_DIR], {
    cwd: REPO_ROOT, detached: true, stdio: "ignore",
  });
  server.unref();
}
function focusOrOpenBoonTab() {
  execFile("osascript", ["-l", "JavaScript", path.join(__dirname, "open-boon.js")], (err, stdout, stderr) => {
    if (err) {
      // Most likely cause: jaeyoung hasn't (or hasn't yet) allowed this app to control Google Chrome. Falls back
      // to a plain launch — it can't focus an existing BOON tab without that permission, but it still gets BOON
      // open rather than doing nothing.
      console.error("open-boon.js failed, falling back to a plain open:", err.message, stderr);
      execFile("open", ["-a", "Google Chrome", BOON_URL], () => {});
    }
  });
}
async function openBoon() {
  if (!(await boonIsUp())) {
    startBoonServer();
    await new Promise((r) => setTimeout(r, 700));
  }
  focusOrOpenBoonTab();
}

// Two instances would each register their own Command+Option+B, and whichever lost that registration race
// would silently have a dead shortcut (observed live, 2026-10-03, after a manual restart briefly left two
// running at once) — refuse a second launch outright instead, and just reassert the existing one on screen.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}
app.on("second-instance", () => reassertVisible());

let iconWindow;
// Keeps a saved position usable even if a display was disconnected/resized since it was saved.
function clampToDisplay(win) {
  const [x, y] = win.getPosition();
  const display = screen.getDisplayNearestPoint({ x, y }) || screen.getPrimaryDisplay();
  const { x: dx, y: dy, width, height } = display.workArea;
  const nx = Math.min(Math.max(x, dx), dx + width - ICON_SIZE);
  const ny = Math.min(Math.max(y, dy), dy + height - ICON_SIZE);
  if (nx !== x || ny !== y) win.setPosition(nx, ny);
}
// Re-applies every always-visible flag, not just show() — found live (2026-10-03) that after the Mac slept
// and woke, the window was still "visible" by Electron's own bookkeeping but not actually on screen, which
// also made the Command+Option+B toggle below useless (it only ever called the plain hide()/show() pair, so
// toggling it just flipped between two states that both looked the same: invisible).
function reassertVisible() {
  if (!iconWindow) return;
  iconWindow.setAlwaysOnTop(true, "screen-saver");
  iconWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  clampToDisplay(iconWindow);
  iconWindow.showInactive();
}
function createIconWindow() {
  const { x, y } = loadPosition();
  iconWindow = new BrowserWindow({
    width: ICON_SIZE, height: ICON_SIZE, x, y,
    frame: false, transparent: true, hasShadow: false,
    alwaysOnTop: true, resizable: false, movable: true,
    skipTaskbar: true, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  iconWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  iconWindow.loadFile("icon.html");
  let saveTimer;
  iconWindow.on("moved", () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => savePosition(iconWindow), 300);
  });
}

ipcMain.on("boon-icon-right-clicked", () => {
  const menu = Menu.buildFromTemplate([
    { label: "Open BOON", click: () => openBoon() },
    { type: "separator" },
    { label: "Quit BOON icon", click: () => app.quit() },
  ]);
  menu.popup({ window: iconWindow });
});

// Dragging is driven entirely from here via polling screen.getCursorScreenPoint(), not from renderer mousemove
// events — the window is only ~84px, so a fast drag can easily carry the cursor past its edge, after which the
// renderer gets no more mouse events at all (they go to whatever's now under the cursor) and tracking would just
// stall. Polling the cursor's absolute position keeps the window chasing it regardless of which window the OS
// currently thinks is "under" the mouse. The same mechanism decides click vs. drag at release (small total
// movement = click) instead of trusting the renderer to detect its own mouseup, which has the identical
// cursor-left-the-window blind spot — plus a hard timeout so a missed release can never wedge the icon to the
// cursor indefinitely.
let drag = null;
function endDrag() {
  if (!drag) return;
  clearInterval(drag.interval);
  clearTimeout(drag.timeout);
  const cur = screen.getCursorScreenPoint();
  const movedPx = Math.hypot(cur.x - drag.cursorStart.x, cur.y - drag.cursorStart.y);
  drag = null;
  if (movedPx < 4) openBoon();
}
ipcMain.on("boon-icon-mouse-down", () => {
  if (drag) endDrag();
  const cursorStart = screen.getCursorScreenPoint();
  const windowStart = iconWindow.getPosition();
  const interval = setInterval(() => {
    const cur = screen.getCursorScreenPoint();
    iconWindow.setPosition(Math.round(windowStart[0] + (cur.x - cursorStart.x)), Math.round(windowStart[1] + (cur.y - cursorStart.y)));
  }, 16);
  const timeout = setTimeout(endDrag, 8000);
  drag = { cursorStart, interval, timeout };
});
ipcMain.on("boon-icon-mouse-up", () => endDrag());

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();
  createIconWindow();
  const bound = globalShortcut.register("Command+Option+B", () => {
    if (iconWindow.isVisible()) iconWindow.hide();
    else reassertVisible();
  });
  if (!bound) console.error("Command+Option+B could not be registered as a global shortcut (already in use).");
  // A sleep/wake cycle (or a display being connected/disconnected) is what was actually observed to leave the
  // window technically "visible" but not really on screen, with no later user action required to trigger it.
  powerMonitor.on("resume", reassertVisible);
  screen.on("display-metrics-changed", reassertVisible);
});
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => {});
