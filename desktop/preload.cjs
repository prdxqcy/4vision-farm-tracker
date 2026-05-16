const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("farmtracksDesktop", {
  isDesktop: true,
  captureScreen: () => ipcRenderer.invoke("farmtracks:capture-screen"),
  closeCurrentWindow: () => ipcRenderer.invoke("farmtracks:close-window"),
  openMainWindow: () => ipcRenderer.invoke("farmtracks:open-main-window"),
  openOverlayWindow: () => ipcRenderer.invoke("farmtracks:open-overlay"),
  setOverlayOpacity: (opacity) => ipcRenderer.invoke("farmtracks:set-overlay-opacity", opacity)
});
