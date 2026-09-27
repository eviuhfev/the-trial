// Runs inside the BOON page (localhost) and passes messages between BOON and the extension.
document.documentElement.dataset.boonFocus = chrome.runtime.getManifest().version;

window.addEventListener("message", (e) => {
  if (e.source !== window || e.data?.source !== "boon-page") return;
  const { id, msg } = e.data;
  chrome.runtime.sendMessage(msg, (reply) => {
    void chrome.runtime.lastError;
    window.postMessage({ source: "boon-focus", id, reply: reply ?? null }, "*");
  });
});

chrome.runtime.onMessage.addListener((event) => {
  window.postMessage({ source: "boon-focus", event }, "*");
});

// Every BOON tab hears when focus ends or the turn-off question opens or closes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.session) return;
  const was = changes.session.oldValue, now = changes.session.newValue;
  const post = (event) => window.postMessage({ source: "boon-focus", event }, "*");
  if (was && !now) post({ type: "ended", reason: changes.lastEnd?.newValue?.reason || "" });
  else if (now && !!was?.quiz !== !!now.quiz) post({ type: "quiz", on: !!now.quiz });
});
