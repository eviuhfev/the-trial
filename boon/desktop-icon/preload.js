const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("boonIcon", {
  clicked: () => ipcRenderer.send("boon-icon-clicked"),
  rightClicked: () => ipcRenderer.send("boon-icon-right-clicked"),
  dragStart: () => ipcRenderer.send("boon-icon-drag-start"),
  dragMove: (dx, dy) => ipcRenderer.send("boon-icon-drag-move", dx, dy),
});
