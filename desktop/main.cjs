const path = require("path");
const fs = require("fs/promises");
const os = require("os");
const { execFile } = require("child_process");
const { app, BrowserWindow, ipcMain, nativeImage, screen } = require("electron");
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

  if (!autoHotkeyPath || !(await fileExists(scriptPath))) {
    return {
      available: false,
      provider: "js-fallback",
      matches: []
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

    await new Promise((resolve, reject) => {
      execFile(autoHotkeyPath, [scriptPath, inputPath, outputPath], { windowsHide: true, timeout: 15000 }, (error) => {
        if (error) {
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
      matches
    };
  } catch (_error) {
    return {
      available: false,
      provider: "js-fallback",
      matches: []
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
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
    width: 560,
    height: 860,
    minWidth: 420,
    minHeight: 620,
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
      matches: detection.matches
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
});

app.on("window-all-closed", async () => {
  if (process.platform !== "darwin") {
    if (localServer) {
      await new Promise((resolve) => localServer.close(resolve));
    }

    app.quit();
  }
});
