// Shown in a tab that tried to leave the focus session; sends you back to your work.
const pad = (n) => String(n).padStart(2, "0");
const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; resolve(r ?? null); }));
send({ type: "status" }).then((r) => {
  const s = r?.session;
  if (!s) { document.getElementById("why").textContent = "The focus session is over. You can close this tab."; return; }
  document.getElementById("title").textContent = `Stay on it: ${s.text}`;
  document.getElementById("why").textContent = s.mode === "hagwon"
    ? "Hagwon mode keeps you on your YouTube mix, a calculator and BOON until the timer ends."
    : "School mode allows your class, links from it, email, a calculator and BOON until the timer ends.";
  const tick = () => {
    const left = Math.max(0, Math.ceil((s.end - Date.now()) / 1000));
    document.getElementById("clock").textContent = `${Math.floor(left / 60)}:${pad(left % 60)}`;
  };
  tick();
  setInterval(tick, 1000);
  if (s.workTab) {
    // This is the work tab itself, parked here after bouncing: offer the work again, and load it soon anyway.
    const back = document.getElementById("back");
    back.hidden = false;
    back.onclick = () => send({ type: "restoreWork" });
    setTimeout(() => send({ type: "restoreWork" }), 12000);
  } else {
    setTimeout(() => send({ type: "bringBack" }), 1500);
  }
});
