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
