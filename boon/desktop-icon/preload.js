const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("boonIcon", {
  rightClicked: () => ipcRenderer.send("boon-icon-right-clicked"),
  mouseDown: () => ipcRenderer.send("boon-icon-mouse-down"),
  mouseUp: () => ipcRenderer.send("boon-icon-mouse-up"),
});
