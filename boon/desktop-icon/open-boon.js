// Run via `osascript -l JavaScript open-boon.js [mode]`. Finds an existing Chrome tab already on BOON and
// focuses it, instead of piling up a new tab every time the floating icon is clicked; opens one only if none
// exists. An optional mode (e.g. "work_in_doc", from the icon's menu) is passed on to BOON as a URL hash —
// including on a tab that's already open: same origin and path, only the hash differs, so Chrome treats it
// as a same-document navigation (BOON picks it up via its own hashchange listener), not a reload. (Tried
// running JS in the tab directly instead, via Chrome's own "execute javascript" — skipped: it needs View >
// Developer > "Allow JavaScript from Apple Events" turned on, which is off by default and easy to miss, so
// the tap would silently do nothing on a fresh Mac.)
function run(argv) {
  const mode = (argv && argv[0]) || "";
  const hash = mode ? "#mode=" + encodeURIComponent(mode) : "";
  // Must match the exact origin BOON's data already lives under (localhost, not 127.0.0.1 — browsers treat
  // those as different origins with separate localStorage, even though they're the same server).
  const url = "http://localhost:6999/";
  const Chrome = Application("Google Chrome");
  if (Chrome.running()) {
    const windows = Chrome.windows();
    for (let wi = 0; wi < windows.length; wi++) {
      const tabs = windows[wi].tabs();
      for (let ti = 0; ti < tabs.length; ti++) {
        if (String(tabs[ti].url()).indexOf(url) === 0) {
          windows[wi].activeTabIndex = ti + 1;
          windows[wi].index = 1;
          Chrome.activate();
          if (mode) tabs[ti].url = url + hash;
          return "focused";
        }
      }
    }
    const win = Chrome.windows[0];
    win.tabs.push(Chrome.Tab({ url: url + hash }));
    win.activeTabIndex = win.tabs.length;
    win.index = 1;
    Chrome.activate();
    return "new-tab";
  }
  Chrome.activate();
  delay(0.5);
  Chrome.windows[0].tabs[0].url = url + hash;
  return "launched";
}
