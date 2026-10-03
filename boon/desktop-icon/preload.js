const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("boonIcon", {
  clicked: () => ipcRenderer.send("boon-icon-clicked"),
  rightClicked: () => ipcRenderer.send("boon-icon-right-clicked"),
});
