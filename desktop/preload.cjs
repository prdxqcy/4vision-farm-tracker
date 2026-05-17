const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("farmtracksDesktop", {
  isDesktop: true,
  captureScreen: (options) => ipcRenderer.invoke("farmtracks:capture-screen", options),
  detectAutoCapture: (profile, options) => ipcRenderer.invoke("farmtracks:detect-auto-capture", profile, options),
  closeCurrentWindow: () => ipcRenderer.invoke("farmtracks:close-window"),
  openMainWindow: () => ipcRenderer.invoke("farmtracks:open-main-window"),
  openOverlayWindow: () => ipcRenderer.invoke("farmtracks:open-overlay"),
  setOverlayOpacity: (opacity) => ipcRenderer.invoke("farmtracks:set-overlay-opacity", opacity),

  // Scanner control
  startScanner: () => ipcRenderer.invoke("farmtracks:scanner-start"),
  stopScanner: () => ipcRenderer.invoke("farmtracks:scanner-stop"),
  getScannerStatus: () => ipcRenderer.invoke("farmtracks:scanner-status"),
  resetPendingRound: () => ipcRenderer.invoke("farmtracks:scanner-reset-pending"),
  endScannerRound: () => ipcRenderer.invoke("farmtracks:scanner-end-round"),

  // Scanner event subscriptions
  onScannerUpdate: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("farmtracks:scanner-update", handler);
    return () => ipcRenderer.removeListener("farmtracks:scanner-update", handler);
  },
  onScannerHotkey: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("farmtracks:scanner-hotkey", handler);
    return () => ipcRenderer.removeListener("farmtracks:scanner-hotkey", handler);
  },

  // Hotkey configuration
  getHotkeys: () => ipcRenderer.invoke("farmtracks:get-hotkeys"),
  setHotkeys: (hotkeys) => ipcRenderer.invoke("farmtracks:set-hotkeys", hotkeys),
  onHotkeysUpdated: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("farmtracks:hotkeys-updated", handler);
    return () => ipcRenderer.removeListener("farmtracks:hotkeys-updated", handler);
  },

  // OCR auto-install progress
  onOcrSetup: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("farmtracks:ocr-setup", handler);
    return () => ipcRenderer.removeListener("farmtracks:ocr-setup", handler);
  },
});
