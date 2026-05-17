const path = require("path");
const fs = require("fs/promises");
const fsSync = require("fs");
const os = require("os");
const { execFile, spawn } = require("child_process");
const readline = require("readline");
const { app, BrowserWindow, ipcMain, nativeImage, screen, globalShortcut } = require("electron");
const screenshot = require("screenshot-desktop");

const OVERLAY_QUERY = "capture-overlay";
const DEV_SERVER_URL = "http://127.0.0.1:5173";
const CUSTOM_PROTOCOL = "farmtracks";
const DEFAULT_OVERLAY_OPACITY = 0.78;

let baseUrl = "";
let localServer = null;
let mainWindow = null;
let overlayWindow = null;
let pendingOverlayOptions = {};
let cachedAutoHotkeyPath = undefined;

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

function getAutoHotkeyScriptPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app.asar.unpacked", "desktop", "ahk", "find-matches.ahk");
  }

  return path.join(__dirname, "ahk", "find-matches.ahk");
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (_error) {
    return false;
  }
}

async function findAutoHotkeyPath() {
  if (cachedAutoHotkeyPath !== undefined) {
    return cachedAutoHotkeyPath;
  }

  const candidates = [
    path.join(process.env.ProgramFiles || "", "AutoHotkey", "v2", "AutoHotkey64.exe"),
    path.join(process.env.ProgramFiles || "", "AutoHotkey", "AutoHotkey64.exe"),
    path.join(process.env.ProgramFiles || "", "AutoHotkey", "AutoHotkey.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "AutoHotkey", "AutoHotkey64.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "AutoHotkey", "AutoHotkey.exe")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      cachedAutoHotkeyPath = candidate;
      return candidate;
    }
  }

  cachedAutoHotkeyPath = null;
  return null;
}

function buildAhkConfig(profile) {
  const displayBounds = screen.getAllDisplays().reduce((bounds, display) => {
    const right = display.bounds.x + display.bounds.width;
    const bottom = display.bounds.y + display.bounds.height;

    return {
      left: Math.min(bounds.left, display.bounds.x),
      top: Math.min(bounds.top, display.bounds.y),
      right: Math.max(bounds.right, right),
      bottom: Math.max(bounds.bottom, bottom)
    };
  }, {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0
  });
  const lines = [
    [
      "bounds",
      displayBounds.left,
      displayBounds.top,
      displayBounds.right,
      displayBounds.bottom,
      72,
      40,
      20
    ].join("|")
  ];

  for (const item of profile?.items ?? []) {
    if (!item?.templateDataUrl || !item?.itemId) {
      continue;
    }

    const maxMatches = item.itemId === "crystals" ? 10 : 4;
    const variation = item.itemId === "crystals" ? 42 : 34;
    lines.push(`${item.itemId}|__TEMPLATE__|__SLOT_SIZE__|${maxMatches}|${variation}|__SCALE__`);
  }

  return lines;
}

async function writeAhkTemplates(tempDir, profile) {
  const templateEntries = [];
  const scales = [0.88, 0.94, 1, 1.06, 1.12];

  for (const item of profile?.items ?? []) {
    if (!item?.templateDataUrl || !item?.itemId) {
      continue;
    }

    const baseImage = nativeImage.createFromDataURL(item.templateDataUrl);

    for (const scale of scales) {
      const width = Math.max(18, Math.round(baseImage.getSize().width * scale));
      const height = Math.max(18, Math.round(baseImage.getSize().height * scale));
      const image = scale === 1 ? baseImage : baseImage.resize({ width, height, quality: "best" });
      const templatePath = path.join(tempDir, `${item.itemId}-${String(scale).replace(".", "_")}.png`);
      await fs.writeFile(templatePath, image.toPNG());
      templateEntries.push({
        itemId: item.itemId,
        path: templatePath,
        slotSize: width,
        scale
      });
    }
  }

  return templateEntries;
}

async function runAutoHotkeyDetector(profile) {
  const autoHotkeyPath = await findAutoHotkeyPath();
  const scriptPath = getAutoHotkeyScriptPath();
  const scriptExists = await fileExists(scriptPath);

  if (!autoHotkeyPath || !scriptExists) {
    return {
      available: false,
      provider: "js-fallback",
      matches: [],
      debug: {
        stage: "preflight",
        autoHotkeyPath: autoHotkeyPath || "",
        scriptPath,
        scriptExists,
        reason: !autoHotkeyPath ? "autohotkey-not-found" : "script-not-found"
      }
    };
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "farmtracks-ahk-"));

  try {
    const configLines = buildAhkConfig(profile);
    const templateEntries = await writeAhkTemplates(tempDir, profile);
    const inputPath = path.join(tempDir, "input.txt");
    const outputPath = path.join(tempDir, "output.txt");

    const entryLines = templateEntries.map((entry) => {
      const templateLine = configLines.find((line) => line.startsWith(`${entry.itemId}|`));
      return templateLine
        .replace("__TEMPLATE__", entry.path)
        .replace("__SLOT_SIZE__", String(entry.slotSize))
        .replace("__SCALE__", String(entry.scale));
    });

    await fs.writeFile(inputPath, [configLines[0], ...entryLines].join("\n"), "utf8");
    const startedAt = Date.now();

    await new Promise((resolve, reject) => {
      execFile(autoHotkeyPath, [scriptPath, inputPath, outputPath], { windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }

        resolve();
      });
    });

    const rawOutput = await fs.readFile(outputPath, "utf8");
    const lines = rawOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const matches = [];

    for (const line of lines.slice(1)) {
      const [itemId, x, y, slotSize, scale] = line.split("|");
      matches.push({
        itemId,
        x: Number.parseInt(x, 10),
        y: Number.parseInt(y, 10),
        slotSize: Number.parseInt(slotSize, 10),
        scale: Number.parseFloat(scale) || 1
      });
    }

    return {
      available: true,
      provider: "autohotkey",
      matches,
      debug: {
        stage: "completed",
        autoHotkeyPath,
        scriptPath,
        scriptExists,
        runtimeMs: Date.now() - startedAt,
        rawLineCount: lines.length,
        rawOutputPreview: lines.slice(0, 6),
        matchCount: matches.length,
        reason: matches.length > 0 ? "matches-found" : "no-matches-returned"
      }
    };
  } catch (error) {
    return {
      available: false,
      provider: "js-fallback",
      matches: [],
      debug: {
        stage: "failed",
        autoHotkeyPath,
        scriptPath,
        scriptExists,
        reason: "execution-failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        stderr: typeof error?.stderr === "string" ? error.stderr.trim() : "",
        stdout: typeof error?.stdout === "string" ? error.stdout.trim() : ""
      }
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
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
// Tesseract OCR – auto-download and silent install on first run
// ---------------------------------------------------------------------------

const TESSERACT_SETUP_URL =
  "https://github.com/UB-Mannheim/tesseract/releases/download/v5.5.0.20241111/tesseract-ocr-w64-setup-5.5.0.20241111.exe";

function getTesseractExePath() {
  if (process.platform !== "win32") return null;
  const candidates = [
    path.join(app.getPath("userData"), "tesseract", "tesseract.exe"),
    "C:\\Program Files\\Tesseract-OCR\\tesseract.exe",
    "C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe",
  ];
  for (const c of candidates) {
    if (fsSync.existsSync(c)) return c;
  }
  return null;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const https = require("https");
    const http = require("http");
    const out = fsSync.createWriteStream(dest);
    out.on("error", reject);

    function fetch(u) {
      const mod = u.startsWith("https") ? https : http;
      mod.get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          fetch(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(out);
        out.on("finish", () => out.close(resolve));
      }).on("error", (err) => {
        try { fsSync.unlinkSync(dest); } catch (_) {}
        reject(err);
      });
    }

    fetch(url);
  });
}

async function ensureTesseract() {
  if (process.platform !== "win32") return;
  if (getTesseractExePath()) return; // already installed

  const installDir = path.join(app.getPath("userData"), "tesseract");
  const installerPath = path.join(os.tmpdir(), "farmtracks-tesseract-setup.exe");

  broadcastToAllWindows("farmtracks:ocr-setup", {
    status: "downloading",
    message: "Setting up OCR engine for the first time (~22 MB)…",
  });

  try {
    await downloadFile(TESSERACT_SETUP_URL, installerPath);

    broadcastToAllWindows("farmtracks:ocr-setup", {
      status: "installing",
      message: "Installing OCR engine…",
    });

    const { spawnSync } = require("child_process");
    spawnSync(
      installerPath,
      ["/VERYSILENT", "/NORESTART", `/DIR=${installDir}`],
      { timeout: 180000, windowsHide: true }
    );

    try { fsSync.unlinkSync(installerPath); } catch (_) {}

    if (getTesseractExePath()) {
      broadcastToAllWindows("farmtracks:ocr-setup", { status: "done", message: "OCR ready" });
      // Restart Python worker so it picks up the new TESSERACT_CMD env var
      stopPythonWorker();
      startPythonWorker();
    } else {
      broadcastToAllWindows("farmtracks:ocr-setup", {
        status: "error",
        message: "OCR install failed — stack counts will show as 1",
      });
    }
  } catch (err) {
    try { fsSync.unlinkSync(installerPath); } catch (_) {}
    broadcastToAllWindows("farmtracks:ocr-setup", {
      status: "error",
      message: "OCR download failed — stack counts will show as 1",
    });
  }
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
  const workerEnv = { ...process.env };
  const tesseractExe = getTesseractExePath();
  if (tesseractExe) workerEnv.TESSERACT_CMD = tesseractExe;

  try {
    pythonWorker = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: workerEnv,
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

ipcMain.handle("farmtracks:capture-screen", async (event, options = {}) => {
  const currentWindow = BrowserWindow.fromWebContents(event.sender);

  if (options.hideCurrentWindow && currentWindow && !currentWindow.isDestroyed()) {
    currentWindow.hide();
    await new Promise((resolve) => setTimeout(resolve, 180));
  }

  const image = await screenshot({ format: "png" });

  if (options.hideCurrentWindow && currentWindow && !currentWindow.isDestroyed()) {
    currentWindow.show();
    currentWindow.focus();
  }

  return `data:image/png;base64,${image.toString("base64")}`;
});

ipcMain.handle("farmtracks:detect-auto-capture", async (event, profile, options = {}) => {
  const currentWindow = BrowserWindow.fromWebContents(event.sender);

  if (options.hideCurrentWindow && currentWindow && !currentWindow.isDestroyed()) {
    currentWindow.hide();
    await new Promise((resolve) => setTimeout(resolve, 180));
  }

  try {
    const [image, detection] = await Promise.all([
      screenshot({ format: "png" }),
      runAutoHotkeyDetector(profile)
    ]);

    return {
      screenshotDataUrl: `data:image/png;base64,${image.toString("base64")}`,
      provider: detection.provider,
      matches: detection.matches,
      debug: detection.debug ?? null
    };
  } finally {
    if (options.hideCurrentWindow && currentWindow && !currentWindow.isDestroyed()) {
      currentWindow.show();
      currentWindow.focus();
    }
  }
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

  // Auto-start the Python scanner
  startPythonWorker();

  // Download and install Tesseract OCR silently in the background if not present.
  // When done it restarts the Python worker so TESSERACT_CMD is available.
  ensureTesseract().catch(() => {});
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
