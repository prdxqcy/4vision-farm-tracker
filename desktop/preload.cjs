const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("farmtracksDesktop", {
  isDesktop: true,
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

  // Per-tracker scan regions
  openTrackerRegionSelector: (trackerKey) => ipcRenderer.invoke("farmtracks:open-tracker-region-selector", trackerKey),
  getTrackerRegions: () => ipcRenderer.invoke("farmtracks:get-tracker-regions"),
  clearTrackerRegion: (trackerKey) => ipcRenderer.invoke("farmtracks:clear-tracker-region", trackerKey),
  onTrackerRegionsUpdated: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("farmtracks:tracker-regions-updated", handler);
    return () => ipcRenderer.removeListener("farmtracks:tracker-regions-updated", handler);
  },
});
