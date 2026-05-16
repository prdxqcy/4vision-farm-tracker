const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("farmtracksDesktop", {
  isDesktop: true,
  closeCurrentWindow: () => ipcRenderer.invoke("farmtracks:close-window"),
  openOverlayWindow: () => ipcRenderer.invoke("farmtracks:open-overlay")
});
