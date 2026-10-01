#!/usr/bin/osascript -l JavaScript
// BOON Mac actions: adds a Mac Reminders item, a Calendar event, or opens an app, for BOON's robot. Chrome runs this
// through boon-focus-host, the same helper that hides other apps during focus; it works any time, not just then.
// The first use of Reminders or Calendar shows macOS's own "BOON Focus Helper wants to..." pop-up once; the user
// has to click Allow there.
//   osascript -l JavaScript actions.js '<request JSON>'   runs one action, prints its result as JSON
// Request: {"id": <number>, "action": "create_reminder"|"create_event"|"open_app", ...fields below}. The app name
// for open_app is checked again here against the same allow-list BOON shows the model, since this script is the
// last place that can say no before anything happens on the Mac.
const APPS = ["Notes", "Reminders", "Calendar", "Music", "Safari", "Messages", "Mail", "Maps", "Photos", "Calculator", "FaceTime", "Spotify"];

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

function createReminder(req) {
  const title = str(req.title, 200);
  const due = when(req.due);
  const Reminders = Application("Reminders");
  const named = req.list ? str(req.list, 60) : "";
  const list = named && Reminders.lists.whose({ name: named })().length ? Reminders.lists.whose({ name: named })()[0] : Reminders.defaultList();
  list.reminders.push(Reminders.Reminder({ name: title, dueDate: due }));
  return { title, due: due.toISOString() };
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

function dispatch(req) {
  if (req.action === "create_reminder") return createReminder(req);
  if (req.action === "create_event") return createEvent(req);
  if (req.action === "open_app") return openApp(req);
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
if (typeof module !== "undefined") module.exports = { dispatch, run, APPS };
