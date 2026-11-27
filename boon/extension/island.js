// The island: a small floating pill on every page during a BOON focus session, with the time left and Turn off.
(() => {
  if (window.top !== window || window.__boonIsland) return;
  window.__boonIsland = true;
  // An island left behind by an older copy of this add-on (it was reloaded) goes away.
  document.querySelectorAll("boon-island").forEach((el) => el.remove());

  const pad = (n) => String(n).padStart(2, "0");
  const clock = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const send = (msg) => new Promise((resolve) => {
    if (!alive()) return resolve(null);
    try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; resolve(r ?? null); }); } catch { resolve(null); }
  });

  let session = null, host = null, ui = null, timer = 0, confirming = false, pos = null;

  function build() {
    host = document.createElement("boon-island");
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;top:12px;left:50%;transform:translateX(-50%);";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      :host { all: initial; }
      .island { font: 600 14px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #e8e8fb;
        background: rgba(12, 12, 19, .94); border-radius: 22px; padding: 7px 7px 7px 14px; display: flex; flex-direction: column; gap: 8px;
        box-shadow: 0 10px 30px rgba(0,0,0,.45), 0 0 0 1px rgba(143,176,255,.28); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
        cursor: grab; user-select: none; -webkit-user-select: none; max-width: min(340px, calc(100vw - 32px)); box-sizing: border-box; }
      .island.dragging { cursor: grabbing; }
      .row { display: flex; align-items: center; gap: 10px; white-space: nowrap; }
      .icon { font-size: 16px; }
      .label { color: #a7aac4; font-weight: 500; overflow: hidden; text-overflow: ellipsis; max-width: 120px; }
      .clock { font-size: 17px; font-weight: 700; color: #8fb0ff; font-variant-numeric: tabular-nums; }
      .left { font-size: 12px; font-weight: 600; color: #ffcf7a; }
      button { all: unset; cursor: pointer; font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        padding: 8px 12px; border-radius: 999px; background: rgba(255,255,255,.1); color: #e8e8fb; text-align: center; }
      button:hover { background: rgba(255,255,255,.18); }
      button:focus-visible { outline: 2px solid #8fb0ff; outline-offset: 2px; }
      button.primary { background: #4f7cff; color: #fff; }
      button.primary:hover { background: #3f6af0; }
      .confirm { white-space: normal; font-weight: 500; color: #c9cbe6; padding: 2px 6px 4px 0; }
      .confirm b { color: #fff; }
      .actions { display: flex; gap: 8px; justify-content: flex-end; }
      [hidden] { display: none !important; }
    </style>
    <div class="island" role="status" aria-live="off">
      <div class="row"><span class="icon" aria-hidden="true"></span><span class="label"></span><span class="clock"></span>
        <span class="left" title="Times you left Chrome during this focus" hidden></span>
        <button type="button" class="off">Turn off</button></div>
      <div class="confirm" hidden>Turning off early gives you <b>a hard algebra question</b>. You have 5 minutes and 3 tries,
        and every other tab stays locked until you finish.
        <div class="actions" style="margin-top:8px"><button type="button" class="keep">Keep going</button><button type="button" class="primary go">Start question</button></div></div>
    </div>`;
    ui = {
      box: root.querySelector(".island"), icon: root.querySelector(".icon"), label: root.querySelector(".label"),
      clock: root.querySelector(".clock"), left: root.querySelector(".left"), off: root.querySelector(".off"), confirm: root.querySelector(".confirm"),
      keep: root.querySelector(".keep"), go: root.querySelector(".go"),
    };
    ui.off.onclick = () => { confirming = !confirming; render(); };
    ui.keep.onclick = () => { confirming = false; render(); };
    ui.go.onclick = async () => { ui.go.textContent = "Opening…"; await send({ type: "turnOff" }); confirming = false; ui.go.textContent = "Start question"; render(); };
    drag();
    place();
  }

  // Drag it anywhere; it remembers the spot.
  function drag() {
    let start = null;
    ui.box.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.composedPath().some((n) => n.tagName === "BUTTON")) return;
      const r = host.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      ui.box.setPointerCapture(e.pointerId);
      ui.box.classList.add("dragging");
    });
    ui.box.addEventListener("pointermove", (e) => {
      if (!start) return;
      pos = { left: start.left + e.clientX - start.x, top: start.top + e.clientY - start.y };
      place();
    });
    const stop = () => {
      if (!start) return;
      start = null;
      ui.box.classList.remove("dragging");
      if (pos && alive()) chrome.storage.local.set({ islandPos: { x: pos.left / innerWidth, y: pos.top / innerHeight } }).catch(() => {});
    };
    ui.box.addEventListener("pointerup", stop);
    ui.box.addEventListener("pointercancel", stop);
  }
  function place() {
    if (!host) return;
    if (!pos) { host.style.left = "50%"; host.style.top = "12px"; host.style.transform = "translateX(-50%)"; return; }
    const w = host.offsetWidth || 220, h = host.offsetHeight || 44;
    const left = Math.min(Math.max(4, pos.left), innerWidth - w - 4), top = Math.min(Math.max(4, pos.top), innerHeight - h - 4);
    host.style.transform = "none";
    host.style.left = left + "px";
    host.style.top = top + "px";
  }

  // In full screen (a YouTube video), only the full-screen element shows, so the island moves inside it.
  function mount() {
    const parent = document.fullscreenElement || document.documentElement;
    if (host.parentNode !== parent) { try { parent.appendChild(host); } catch { document.documentElement.appendChild(host); } }
  }

  // Gone for good until the next session: a fresh island is built then.
  function teardown() { stopTimer(); host?.remove(); host = ui = null; confirming = false; }

  function render() {
    if (!alive()) { teardown(); return; }
    const live = session && Date.now() < session.end;
    if (!live) { teardown(); return; }
    if (!host) build();
    mount();
    ui.icon.textContent = session.quiz ? "🧮" : session.mode === "hagwon" ? "🎧" : "🏫";
    ui.label.textContent = session.quiz ? "Question open" : session.mode === "hagwon" ? "Hagwon" : "School";
    ui.clock.textContent = clock((session.quiz ? session.quiz.until : session.end) - Date.now());
    ui.left.textContent = `left ${session.left}×`;
    ui.left.hidden = !session.left;
    ui.off.hidden = !!session.quiz;
    ui.off.textContent = confirming ? "Cancel" : "Turn off";
    ui.confirm.hidden = !confirming || !!session.quiz;
    place();   // keep the whole island on screen as it grows or shrinks
    if (!timer) timer = setInterval(render, 1000);
  }
  const stopTimer = () => { clearInterval(timer); timer = 0; };

  async function load() {
    if (!alive()) return;
    const got = await chrome.storage.local.get(["session", "islandPos"]).catch(() => ({}));
    session = got.session || null;
    if (got.islandPos) pos = { left: got.islandPos.x * innerWidth, top: got.islandPos.y * innerHeight };
    render();
    place();
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.session) return;
    session = changes.session.newValue || null;
    render();
  });
  document.addEventListener("fullscreenchange", () => { if (host && session && alive()) { mount(); place(); } });
  addEventListener("resize", place);
  // Coming into view: let the add-on check this tab is allowed (catches tricks like dragging tabs).
  const check = () => { if (document.visibilityState === "visible" && session && alive()) send({ type: "check" }); };
  document.addEventListener("visibilitychange", check);
  load().then(check);
})();
