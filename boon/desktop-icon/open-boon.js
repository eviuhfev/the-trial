// Run via `osascript -l JavaScript open-boon.js`. Finds an existing Chrome tab already on BOON and focuses it,
// instead of piling up a new tab every time the floating icon is clicked; opens one only if none exists.
function run() {
  const url = "http://127.0.0.1:6999/";
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
          return "focused";
        }
      }
    }
    const win = Chrome.windows[0];
    win.tabs.push(Chrome.Tab({ url: url }));
    win.activeTabIndex = win.tabs.length;
    win.index = 1;
    Chrome.activate();
    return "new-tab";
  }
  Chrome.activate();
  delay(0.5);
  Chrome.windows[0].tabs[0].url = url;
  return "launched";
}
