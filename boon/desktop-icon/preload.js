const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("boonIcon", {
  mouseDown: () => ipcRenderer.send("boon-icon-mouse-down"),
  mouseUp: () => ipcRenderer.send("boon-icon-mouse-up"),
});
