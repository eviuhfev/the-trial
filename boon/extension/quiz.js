// The turn-off question. The add-on keeps every other tab locked while it's open.
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");
const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; resolve(r ?? null); }));
let until = 0, finished = false, timer = 0;

function closeSoon(ms, back) {
  finished = true;
  clearInterval(timer);
  $("form").hidden = true;
  $("tries").textContent = "";
  setTimeout(async () => {
    if (back) await send({ type: "bringBack" });
    const tab = await chrome.tabs.getCurrent();
    if (tab) chrome.tabs.remove(tab.id);
  }, ms);
}

function showEnd(r) {
  if (r?.correct) {
    $("head").textContent = "Correct!";
    $("msg").className = "msg good";
    $("msg").textContent = "Focus is off. Nice work.";
    $("note").textContent = "This tab closes by itself.";
    closeSoon(3000, false);
    return;
  }
  const last = r?.last || r || {};
  $("head").textContent = last.timeUp ? "Time's up" : "Not this time";
  $("msg").className = "msg bad";
  $("msg").textContent = (last.answer ? `The answer was ${last.answer}. ` : "") + "Focus keeps going.";
  $("note").textContent = "Taking you back in a few seconds. You can try Turn off again later for a new question.";
  closeSoon(6000, true);
}

function tick() {
  const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
  $("clock").textContent = `${Math.floor(left / 60)}:${pad(left % 60)}`;
  $("clock").classList.toggle("low", left <= 60);
  if (!left && !finished) load();
}

function showOver() {
  $("head").textContent = "Focus is over";
  $("question").textContent = "";
  $("prompt").textContent = "";
  $("msg").className = "msg good";
  $("msg").textContent = "The timer ran out, so you're free. This tab closes by itself.";
  $("note").textContent = "";
  closeSoon(4000, false);
}

// The focus timer can run out while the question is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.session && !changes.session.newValue && changes.lastEnd?.newValue?.reason === "time" && !finished) showOver();
});

async function load() {
  const r = await send({ type: "quizStatus" });
  if (!r?.active) {
    if (r?.over) { showOver(); return; }
    $("question").innerHTML = $("question").innerHTML === "Loading…" ? "" : $("question").innerHTML;
    showEnd(r);
    return;
  }
  // The question is built by the add-on from numbers only (see algebra.js), so it's safe to show as HTML.
  $("question").innerHTML = r.html;
  $("prompt").textContent = r.prompt;
  $("tries").textContent = `${r.triesLeft} ${r.triesLeft === 1 ? "try" : "tries"} left`;
  until = r.until;
  if (!timer) timer = setInterval(tick, 1000);
  tick();
}

$("form").onsubmit = async (e) => {
  e.preventDefault();
  const value = $("answer").value.trim();
  if (!value || finished) return;
  $("submit").disabled = true;
  const r = await send({ type: "answer", value });
  $("submit").disabled = false;
  if (!r) return;
  if (r.over) { showOver(); return; }
  if (r.done) { showEnd(r.lost ? { answer: "" } : r); return; }
  $("msg").className = "msg bad";
  $("msg").textContent = "Not quite. Try again.";
  $("tries").textContent = `${r.triesLeft} ${r.triesLeft === 1 ? "try" : "tries"} left`;
  $("answer").select();
};

load();
