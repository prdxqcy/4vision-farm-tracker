const path = require("path");
const fsSync = require("fs");
const { spawn } = require("child_process");
const readline = require("readline");
const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require("electron");

const OVERLAY_QUERY = "capture-overlay";
const DEV_SERVER_URL = "http://127.0.0.1:5173";
const CUSTOM_PROTOCOL = "farmtracks";
const DEFAULT_OVERLAY_OPACITY = 0.78;

let baseUrl = "";
let localServer = null;
let mainWindow = null;
let overlayWindow = null;
let pendingOverlayOptions = {};
// Python scanner worker state
let pythonWorker = null;
let pythonWorkerRunning = false;
let pythonWorkerRestartTimer = null;
const PYTHON_RESTART_DELAY_MS = 3000;

const HOTKEYS_CONFIG_FILE = "hotkeys.json"; // resolved after app is ready
const DEFAULT_HOTKEYS = { toggleOverlay: "F7", resetPending: "F8", endRound: "F9" };
let currentHotkeys = { ...DEFAULT_HOTKEYS };

const singleInstanceLock = app.requestSingleInstanceLock();

if (!singleInstanceLock) {
  app.quit();
}

function isDevelopment() {
  return !app.isPackaged;
}

function findProtocolUrl(argv = []) {
  return argv.find((value) => typeof value === "string" && value.startsWith(`${CUSTOM_PROTOCOL}://`)) ?? "";
}

function parseProtocolUrl(protocolUrl) {
  if (!protocolUrl) {
    return null;
  }

  try {
    const url = new URL(protocolUrl);
    const host = url.hostname.toLowerCase();
    const pathname = url.pathname.replace(/^\/+/, "").toLowerCase();
    const action = host || pathname;

    if (action !== "open-overlay") {
      return null;
    }

    const mapId = url.searchParams.get("map");

    return {
      map: mapId || undefined
    };
  } catch (_error) {
    return null;
  }
}

function buildAppUrl(query = {}) {
  const url = new URL(baseUrl);

  Object.entries(query).forEach(([key, value]) => {
    if (value) {
      url.searchParams.set(key, value);
    }
  });

  return url.toString();
}

async function ensureBaseUrl() {
  if (isDevelopment()) {
    baseUrl = DEV_SERVER_URL;
    return;
  }

  const serverApp = require("../server/app");

  localServer = await new Promise((resolve, reject) => {
    const server = serverApp.listen(0, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });

  const { port } = localServer.address();
  baseUrl = `http://127.0.0.1:${port}`;
}

function sharedWebPreferences() {
  return {
    preload: path.join(__dirname, "preload.cjs"),
    contextIsolation: true,
    nodeIntegration: false,
    spellcheck: false
  };
}



function getPythonWorkerPath() {
  if (app.isPackaged) {
    // Packaged: use the compiled farmtracks-capture.exe in extraResources
    return path.join(process.resourcesPath, "python", "farmtracks-capture", "farmtracks-capture.exe");
  }
  // Development: run the script directly with python
  return null; // signals to use python command
}

// ---------------------------------------------------------------------------
// Tracker regions – per-item screen regions for OCR scanning
// ---------------------------------------------------------------------------

const DEFAULT_TRACKER_REGIONS = {
  crystals: { region: null },
  arcanes: { region: null },
  "speed-potions": { region: null },
};

const TRACKER_LABELS = {
  crystals: "Crystals",
  arcanes: "Arcanes",
  "speed-potions": "Potions",
};

const TRACKER_REGIONS_FILE = () => path.join(app.getPath("userData"), "tracker_regions.json");

let trackerRegions = JSON.parse(JSON.stringify(DEFAULT_TRACKER_REGIONS));

function loadTrackerRegions() {
  try {
    const data = fsSync.readFileSync(TRACKER_REGIONS_FILE(), "utf8");
    const saved = JSON.parse(data);
    trackerRegions = { ...JSON.parse(JSON.stringify(DEFAULT_TRACKER_REGIONS)), ...saved };
  } catch (_) {
    trackerRegions = JSON.parse(JSON.stringify(DEFAULT_TRACKER_REGIONS));
  }
}

function saveTrackerRegions() {
  try {
    fsSync.writeFileSync(TRACKER_REGIONS_FILE(), JSON.stringify(trackerRegions, null, 2));
  } catch (_) {}
}

function sendConfigToPython() {
  if (!pythonWorker || !pythonWorker.stdin.writable) return;
  const payload = {
    type: "config",
    trackers: trackerRegions,
    pollIntervalMs: 650,
  };
  try {
    pythonWorker.stdin.write(JSON.stringify(payload) + "\n");
  } catch (_) {}
}

let regionSelectorWindow = null;
let pendingTrackerKey = null;

function openRegionSelector(trackerKey) {
  if (regionSelectorWindow) {
    regionSelectorWindow.focus();
    return;
  }

  pendingTrackerKey = trackerKey || "crystals";
  const label = TRACKER_LABELS[pendingTrackerKey] ?? pendingTrackerKey;

  regionSelectorWindow = new BrowserWindow({
    fullscreen: true,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  regionSelectorWindow.loadFile(path.join(__dirname, "select-region.html"), {
    query: { trackerKey: pendingTrackerKey, label },
  });

  const cleanup = () => {
    ipcMain.removeAllListeners("select-region:done");
    ipcMain.removeAllListeners("select-region:cancel");
    if (regionSelectorWindow && !regionSelectorWindow.isDestroyed()) {
      regionSelectorWindow.close();
    }
    regionSelectorWindow = null;
    pendingTrackerKey = null;
  };

  ipcMain.once("select-region:done", (_event, region) => {
    const key = pendingTrackerKey;
    if (key && trackerRegions[key] !== undefined) {
      trackerRegions[key] = { region };
      saveTrackerRegions();
      broadcastToAllWindows("farmtracks:tracker-regions-updated", trackerRegions);
      sendConfigToPython();
    }
    cleanup();
  });

  ipcMain.once("select-region:cancel", cleanup);
  regionSelectorWindow.on("closed", () => {
    ipcMain.removeAllListeners("select-region:done");
    ipcMain.removeAllListeners("select-region:cancel");
    regionSelectorWindow = null;
    pendingTrackerKey = null;
  });
}


function getPythonCommand() {
  if (app.isPackaged) {
    return { cmd: getPythonWorkerPath(), args: [] };
  }
  const script = path.join(__dirname, "python", "capture_worker.py");
  // On Windows, "python" may not be in PATH but "py" (the launcher) usually is.
  // Try py first, then python, then python3.
  const candidates = process.platform === "win32"
    ? ["py", "python", "python3"]
    : ["python3", "python"];
  for (const cmd of candidates) {
    try {
      const result = require("child_process").spawnSync(cmd, ["--version"], { windowsHide: true, timeout: 3000 });
      if (result.status === 0) {
        return { cmd, args: [script] };
      }
    } catch (_) {
      // not found, try next
    }
  }
  return { cmd: candidates[0], args: [script] };
}

function broadcastToAllWindows(channel, payload) {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  });
}

function startPythonWorker() {
  if (pythonWorker) return; // already running

  const { cmd, args } = getPythonCommand();

  try {
    pythonWorker = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (err) {
    broadcastToAllWindows("farmtracks:scanner-update", {
      type: "error",
      ok: false,
      message: `Failed to start Python worker: ${err.message}`,
      debug: {},
    });
    schedulePythonWorkerRestart();
    return;
  }

  pythonWorkerRunning = true;

  // Send initial tracker region config so Python starts scanning immediately
  setTimeout(sendConfigToPython, 200);

  const rl = readline.createInterface({ input: pythonWorker.stdout });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const payload = JSON.parse(trimmed);
      broadcastToAllWindows("farmtracks:scanner-update", payload);
    } catch (_) {
      // Non-JSON stdout — ignore silently
    }
  });

  pythonWorker.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      console.error("[python-worker]", text);
    }
  });

  pythonWorker.on("close", (code) => {
    pythonWorker = null;
    pythonWorkerRunning = false;
    if (code !== 0 && code !== null) {
      broadcastToAllWindows("farmtracks:scanner-update", {
        type: "error",
        ok: false,
        message: `Python worker exited with code ${code}. Restarting...`,
        debug: { exitCode: code },
      });
      schedulePythonWorkerRestart();
    }
  });

  pythonWorker.on("error", (err) => {
    broadcastToAllWindows("farmtracks:scanner-update", {
      type: "error",
      ok: false,
      message: `Python worker error: ${err.message}`,
      debug: {},
    });
    pythonWorker = null;
    pythonWorkerRunning = false;
    schedulePythonWorkerRestart();
  });
}

function stopPythonWorker() {
  if (pythonWorkerRestartTimer) {
    clearTimeout(pythonWorkerRestartTimer);
    pythonWorkerRestartTimer = null;
  }
  if (pythonWorker) {
    pythonWorkerRunning = false;
    pythonWorker.kill("SIGTERM");
    pythonWorker = null;
  }
}

function schedulePythonWorkerRestart() {
  if (pythonWorkerRestartTimer) return;
  pythonWorkerRestartTimer = setTimeout(() => {
    pythonWorkerRestartTimer = null;
    if (!pythonWorkerRunning) {
      startPythonWorker();
    }
  }, PYTHON_RESTART_DELAY_MS);
}

function getHotkeysConfigPath() {
  return path.join(app.getPath("userData"), HOTKEYS_CONFIG_FILE);
}

function loadHotkeysConfig() {
  try {
    const raw = fsSync.readFileSync(getHotkeysConfigPath(), "utf8");
    return { ...DEFAULT_HOTKEYS, ...JSON.parse(raw) };
  } catch (_) {
    return { ...DEFAULT_HOTKEYS };
  }
}

function saveHotkeysConfig(hotkeys) {
  try {
    fsSync.writeFileSync(getHotkeysConfigPath(), JSON.stringify(hotkeys, null, 2), "utf8");
  } catch (_) {}
}

function registerHotkeys(hotkeys) {
  globalShortcut.unregisterAll();

  if (hotkeys.toggleOverlay) {
    try {
      globalShortcut.register(hotkeys.toggleOverlay, () => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          if (overlayWindow.isVisible()) {
            overlayWindow.hide();
          } else {
            overlayWindow.show();
            overlayWindow.focus();
          }
        }
      });
    } catch (_) {}
  }

  if (hotkeys.resetPending) {
    try {
      globalShortcut.register(hotkeys.resetPending, () => {
        broadcastToAllWindows("farmtracks:scanner-hotkey", { action: "reset-pending" });
      });
    } catch (_) {}
  }

  if (hotkeys.endRound) {
    try {
      globalShortcut.register(hotkeys.endRound, () => {
        broadcastToAllWindows("farmtracks:scanner-hotkey", { action: "end-round" });
      });
    } catch (_) {}
  }

  currentHotkeys = hotkeys;
}

function registerProtocolClient() {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(CUSTOM_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    return;
  }

  app.setAsDefaultProtocolClient(CUSTOM_PROTOCOL);
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: "#05070b",
    autoHideMenuBar: true,
    webPreferences: sharedWebPreferences()
  });

  mainWindow.loadURL(buildAppUrl());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createOverlayWindow(options = {}) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    if (options.map) {
      overlayWindow.loadURL(buildAppUrl({ [OVERLAY_QUERY]: "1", map: options.map }));
    }

    overlayWindow.show();
    overlayWindow.focus();
    return;
  }

  const display = screen.getPrimaryDisplay();
  const { x, y, width } = display.workArea;

  overlayWindow = new BrowserWindow({
    width: 340,
    height: 420,
    minWidth: 300,
    minHeight: 360,
    x: Math.max(x + 24, x + width - 584),
    y: y + 24,
    frame: false,
    titleBarStyle: "hidden",
    backgroundColor: "#05070b",
    autoHideMenuBar: true,
    resizable: true,
    alwaysOnTop: true,
    opacity: DEFAULT_OVERLAY_OPACITY,
    maximizable: false,
    fullscreenable: false,
    webPreferences: sharedWebPreferences()
  });

  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.loadURL(buildAppUrl({ [OVERLAY_QUERY]: "1", map: options.map }));

  overlayWindow.on("closed", () => {
    overlayWindow = null;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.focus();
    }
  });
}

ipcMain.handle("farmtracks:open-overlay", () => {
  createOverlayWindow();
});

ipcMain.handle("farmtracks:open-main-window", () => {
  createMainWindow();
});

ipcMain.handle("farmtracks:set-overlay-opacity", (_event, opacity) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return DEFAULT_OVERLAY_OPACITY;
  }

  const safeOpacity = Math.min(1, Math.max(0.35, Number(opacity) || DEFAULT_OVERLAY_OPACITY));
  overlayWindow.setOpacity(safeOpacity);
  return safeOpacity;
});


ipcMain.handle("farmtracks:close-window", (event) => {
  const currentWindow = BrowserWindow.fromWebContents(event.sender);
  currentWindow?.close();
});

ipcMain.handle("farmtracks:scanner-start", () => {
  startPythonWorker();
  return { running: pythonWorkerRunning };
});

ipcMain.handle("farmtracks:scanner-stop", () => {
  stopPythonWorker();
  return { running: false };
});

ipcMain.handle("farmtracks:scanner-status", () => ({
  running: pythonWorkerRunning,
}));

ipcMain.handle("farmtracks:scanner-reset-pending", () => {
  broadcastToAllWindows("farmtracks:scanner-hotkey", { action: "reset-pending" });
  return { ok: true };
});

ipcMain.handle("farmtracks:scanner-end-round", () => {
  broadcastToAllWindows("farmtracks:scanner-hotkey", { action: "end-round" });
  return { ok: true };
});

ipcMain.handle("farmtracks:open-tracker-region-selector", (_event, trackerKey) => {
  openRegionSelector(trackerKey);
  return { ok: true };
});

ipcMain.handle("farmtracks:get-tracker-regions", () => trackerRegions);

ipcMain.handle("farmtracks:clear-tracker-region", (_event, trackerKey) => {
  if (trackerRegions[trackerKey] !== undefined) {
    trackerRegions[trackerKey] = { region: null };
    saveTrackerRegions();
    broadcastToAllWindows("farmtracks:tracker-regions-updated", trackerRegions);
    sendConfigToPython();
  }
  return { ok: true };
});

ipcMain.handle("farmtracks:get-hotkeys", () => currentHotkeys);

ipcMain.handle("farmtracks:set-hotkeys", (_event, hotkeys) => {
  const next = { ...DEFAULT_HOTKEYS, ...hotkeys };
  saveHotkeysConfig(next);
  registerHotkeys(next);
  broadcastToAllWindows("farmtracks:hotkeys-updated", next);
  return next;
});

function focusMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  createMainWindow();
}

if (singleInstanceLock) {
  const initialProtocolUrl = findProtocolUrl(process.argv);
  const parsedInitialProtocol = parseProtocolUrl(initialProtocolUrl);

  if (parsedInitialProtocol) {
    pendingOverlayOptions = parsedInitialProtocol;
  }

  app.on("second-instance", (_event, argv) => {
    const protocolUrl = findProtocolUrl(argv);
    const protocolRequest = parseProtocolUrl(protocolUrl);

    if (protocolRequest) {
      pendingOverlayOptions = protocolRequest;
      createOverlayWindow(protocolRequest);
      return;
    }

    if (isDevelopment()) {
      focusMainWindow();
      return;
    }

    createOverlayWindow();
  });

  app.on("open-url", (event, protocolUrl) => {
    event.preventDefault();

    const protocolRequest = parseProtocolUrl(protocolUrl);

    if (protocolRequest) {
      pendingOverlayOptions = protocolRequest;
      createOverlayWindow(protocolRequest);
    }
  });
}

app.whenReady().then(async () => {
  registerProtocolClient();
  await ensureBaseUrl();

  if (isDevelopment()) {
    createMainWindow();
  } else {
    createOverlayWindow(pendingOverlayOptions);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (isDevelopment()) {
        createMainWindow();
        return;
      }

      createOverlayWindow();
    }
  });

  // Load and register hotkeys (user-configurable, stored in userData/hotkeys.json)
  currentHotkeys = loadHotkeysConfig();
  registerHotkeys(currentHotkeys);

  // Load saved tracker regions before starting the Python worker
  loadTrackerRegions();

  // Auto-start the Python scanner
  startPythonWorker();
});

app.on("window-all-closed", async () => {
  if (process.platform !== "darwin") {
    if (localServer) {
      await new Promise((resolve) => localServer.close(resolve));
    }

    stopPythonWorker();
    globalShortcut.unregisterAll();
    app.quit();
  }
});
