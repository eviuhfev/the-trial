// BOON's floating desktop icon: a small always-on-top widget, separate from the browser tab, that sits on screen
// and opens BOON (starting its local server if needed) when clicked. See install.sh for how it's kept running
// across restarts.
const { app, BrowserWindow, ipcMain, Menu, screen } = require("electron");
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

let iconWindow;
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

ipcMain.on("boon-icon-clicked", () => { openBoon(); });
ipcMain.on("boon-icon-right-clicked", () => {
  const menu = Menu.buildFromTemplate([
    { label: "Open BOON", click: () => openBoon() },
    { type: "separator" },
    { label: "Quit BOON icon", click: () => app.quit() },
  ]);
  menu.popup({ window: iconWindow });
});

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();
  createIconWindow();
});
app.on("window-all-closed", () => {});
