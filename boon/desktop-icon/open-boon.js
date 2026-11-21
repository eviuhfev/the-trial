// Run via `osascript -l JavaScript open-boon.js [mode]`. Finds an existing Chrome tab already on BOON and
// focuses it, instead of piling up a new tab every time the floating icon is clicked; opens one only if none
// exists. An optional mode (e.g. "work_in_doc", from the icon's menu) is passed on to BOON: as a URL hash when
// opening or launching fresh, since there's nothing yet there to disturb; for a tab that's already open, as a
// live message instead, since changing its URL would reload it and drop whatever chat was already in progress.
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
          if (mode) {
            try { windows[wi].tabs[ti].execute({ javascript: "window.postMessage({source:'boon-icon-tap',mode:" + JSON.stringify(mode) + "},'*');" }); }
            catch (e) {}
          }
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
