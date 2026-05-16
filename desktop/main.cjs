const path = require("path");
const { app, BrowserWindow, ipcMain, screen } = require("electron");
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
