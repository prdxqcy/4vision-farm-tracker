import { useEffect, useMemo, useRef, useState } from "react";
import {
  NARWASHI_AUTO_CAPTURE_ITEMS,
  captureDesktopScreenshot,
  clearNarwashiAutoCaptureProfile,
  createNarwashiAutoCaptureProfile,
  loadNarwashiAutoCaptureProfile,
  scanNarwashiScreen
} from "./autoCapture";
import { MAPS, STACK_SIZE } from "./mapConfig";
import { loadPlayers, loadUiState, savePlayers, saveUiState } from "./storage";
import {
  applyRound,
  createNewPlayer,
  finishSession,
  getRoundGains,
  getStackProgress,
  getTotalItems,
  hasNegativeGain,
  hasPositiveGain,
  normalizeRoundInput,
  resetMapProgress
} from "./utils";

const DEFAULT_MAP_ID = MAPS[0].id;
const INVENTORY_POPOUT_QUERY = "capture-overlay";
const DEFAULT_OVERLAY_INSTALLER_URL = "https://github.com/prdxqcy/4vision-farm-tracker/releases/latest/download/FarmTracks-Overlay-Setup.exe";
const OVERLAY_INSTALLER_URL = import.meta.env.VITE_OVERLAY_INSTALLER_URL || DEFAULT_OVERLAY_INSTALLER_URL;
const OVERLAY_PROTOCOL = "farmtracks://open-overlay";
const ONBOARDING_VERSION = "2026-05-16";
const GUIDE_TRANSLATION_LANGUAGES = [
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "pt", label: "Portuguese" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "it", label: "Italian" },
  { value: "pl", label: "Polish" },
  { value: "tr", label: "Turkish" },
  { value: "ru", label: "Russian" },
  { value: "ar", label: "Arabic" }
];

function isDesktopShellAvailable() {
  return typeof window !== "undefined" && Boolean(window.farmtracksDesktop?.isDesktop);
}

function getRequestedMapId() {
  if (typeof window === "undefined") {
    return "";
  }

  return new URLSearchParams(window.location.search).get("map") ?? "";
}

function getProtocolLaunchUrl(mapId) {
  const launchUrl = new URL(OVERLAY_PROTOCOL);

  if (mapId) {
    launchUrl.searchParams.set("map", mapId);
  }

  return launchUrl.toString();
}

function triggerDesktopProtocol(url) {
  const launchLink = document.createElement("a");
  launchLink.href = url;
  launchLink.style.display = "none";
  document.body.appendChild(launchLink);
  launchLink.click();
  launchLink.remove();
}

function formatDate(value) {
  return new Date(value).toLocaleString();
}

function buildGuideTranslationUrl(language, guideText) {
  const translateUrl = new URL("https://translate.google.com/");
  translateUrl.searchParams.set("sl", "auto");
  translateUrl.searchParams.set("tl", language);
  translateUrl.searchParams.set("text", guideText);
  translateUrl.searchParams.set("op", "translate");
  return translateUrl.toString();
}

function formatAutoCaptureDebugLines(lastResult) {
  if (!lastResult?.debug) {
    return [];
  }

  const lines = [];
  const desktopDebug = lastResult.debug.desktopDetection;

  lines.push(`Detector: ${lastResult.provider === "autohotkey" ? "AutoHotkey" : "Built-in scanner"}`);

  if (desktopDebug) {
    lines.push(`AHK stage: ${desktopDebug.stage || "unknown"}`);

    if (desktopDebug.reason) {
      lines.push(`AHK reason: ${desktopDebug.reason}`);
    }

    if (desktopDebug.matchCount !== undefined) {
      lines.push(`AHK matches: ${desktopDebug.matchCount}`);
    }

    if (desktopDebug.runtimeMs !== undefined) {
      lines.push(`AHK runtime: ${desktopDebug.runtimeMs}ms`);
    }

    if (desktopDebug.autoHotkeyPath) {
      lines.push(`AHK exe: ${desktopDebug.autoHotkeyPath}`);
    }

    if (desktopDebug.errorMessage) {
      lines.push(`AHK error: ${desktopDebug.errorMessage}`);
    }

    if (desktopDebug.stderr) {
      lines.push(`AHK stderr: ${desktopDebug.stderr}`);
    }
  } else {
    lines.push("AHK stage: desktop bridge unavailable");
  }

  if (lastResult.provider !== "autohotkey" && lastResult.debug.fallbackReason) {
    lines.push(`Fallback: ${lastResult.debug.fallbackReason}`);
    lines.push(`Built-in matches: ${lastResult.debug.jsMatchCount}`);
  }

  return lines;
}

function splitAmount(total) {
  return {
    stacks: Math.floor(total / STACK_SIZE),
    loose: total % STACK_SIZE
  };
}

function buildInventoryInputs(map, snapshot = {}) {
  return map.items.reduce((accumulator, item) => {
    const amount = snapshot[item.id] ?? 0;
    const split = splitAmount(amount);
    accumulator[item.id] = {
      stacks: String(split.stacks || ""),
      loose: String(split.loose || "")
    };
    return accumulator;
  }, {});
}

function mergeWithCurrentSnapshot(map, currentSnapshot = {}, detectedSnapshot = {}) {
  return map.items.reduce((snapshot, item) => {
    snapshot[item.id] = Math.max(currentSnapshot[item.id] ?? 0, detectedSnapshot[item.id] ?? 0);
    return snapshot;
  }, {});
}

function OverlayWindowControls({ onClose, onOpenDashboard, onOpacityChange, opacityValue, showDashboardButton }) {
  return (
    <div className="overlay-header-meta">
      <label className="overlay-opacity-control">
        <span className="overlay-opacity-label">Opacity {opacityValue}%</span>
        <input
          type="range"
          min="45"
          max="100"
          step="1"
          value={opacityValue}
          onChange={(event) => onOpacityChange(Number(event.target.value))}
        />
      </label>
      {showDashboardButton ? (
        <button type="button" className="ghost-button overlay-action-button overlay-close-button" onClick={onOpenDashboard}>
          Dashboard
        </button>
      ) : null}
      <button type="button" className="ghost-button overlay-action-button overlay-close-button" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

function OverlayAccessPanel({ guideMode, installerUrl, isDesktopShell, mapName, onDismiss, onInstall, onLaunch }) {
  const guideCopy = {
    install: {
      eyebrow: "Install Started",
      title: "Set up the Windows overlay app",
      steps: [
        "Your browser should start downloading the FarmTracks Overlay installer.",
        "If Windows SmartScreen appears, press 'More info' and then 'Run anyway' because this installer is not code-signed yet.",
        "Open the downloaded installer and approve the Windows prompt if it appears.",
        "Leave 'Launch FarmTracks Overlay' enabled at the end of setup so the app opens immediately.",
        "Return to this page after installation and press Launch Overlay whenever you want the in-game panel."
      ]
    },
    launch: {
      eyebrow: "Launch Requested",
      title: "Open the overlay on this route",
      steps: [
        `Your browser is asking Windows to open the FarmTracks Overlay app for ${mapName}.`,
        "If Windows shows an 'Open FarmTracks Overlay' prompt, approve it to continue.",
        "If nothing opens, install the overlay app first and launch it once manually so Windows registers the farmtracks:// link handler."
      ]
    },
    desktop: {
      eyebrow: "Desktop Mode",
      title: "Open the native overlay window",
      steps: [
        `Press Open Overlay to launch the always-on-top panel for ${mapName}.`,
        "Drag the overlay by its header and keep it near your game HUD.",
        "Close the overlay window any time and reopen it from this page."
      ]
    }
  };

  const activeGuide = guideMode ? guideCopy[guideMode] : null;

  return (
    <section className="page-panel overlay-access-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">{isDesktopShell ? "Overlay Control" : "Overlay Access"}</p>
          <h2>Launch the in-game panel</h2>
          <p className="subtle-text">
            {isDesktopShell
              ? "This desktop build can open the native always-on-top overlay directly."
              : "Install the Windows helper once, then come back here to open the overlay from the website."}
          </p>
        </div>
        <div className="overlay-launch-actions">
          {!isDesktopShell ? (
            <a
              className="secondary-button overlay-link-button"
              href={installerUrl}
              onClick={onInstall}
              target="_blank"
              rel="noreferrer"
            >
              Install Overlay App
            </a>
          ) : null}
          <button type="button" className="primary-button" onClick={onLaunch}>
            {isDesktopShell ? "Open Overlay" : "Launch Overlay"}
          </button>
        </div>
      </div>

      {activeGuide ? (
        <div className="overlay-guide">
          <div className="overlay-guide-copy">
            <p className="eyebrow">{activeGuide.eyebrow}</p>
            <strong>{activeGuide.title}</strong>
          </div>
          <ol className="overlay-guide-steps">
            {activeGuide.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {!isDesktopShell && guideMode === "install" ? (
            <p className="helper-text">
              Installer URL: <a href={installerUrl}>{installerUrl}</a>
            </p>
          ) : null}
          <button type="button" className="ghost-button" onClick={onDismiss}>
            Hide instructions
          </button>
        </div>
      ) : null}
    </section>
  );
}

function WelcomeGuideModal({
  installerUrl,
  isDesktopShell,
  language,
  mapName,
  onClose,
  onInstall,
  onLanguageChange,
  onLaunchOverlay
}) {
  const guideText = [
    "FarmTracks quick guide.",
    "Step 1: Choose your farming route from the left sidebar.",
    "Step 2: After each route clear, enter the current item counts from your bag into the tracker.",
    "Step 3: Press Capture round to save the gain for that run.",
    "Step 4: Use Finish session when you want to archive the current run and start a clean one.",
    "Auto-capture guide.",
    "Auto-capture is available in the installed desktop app for Narwashi.",
    "Press Calibrate once and click one crystal, one arcane, and one speed potion on the captured screenshot.",
    "After calibration, Auto-fill reads visible open bags and fills the bag counts for you.",
    "Auto-capture round reads the bags and records the round immediately when the values increased.",
    "Overlay guide.",
    "The installed desktop app gives you the best overlay experience and opens a native always-on-top window beside the game.",
    "Keep your bags visible during auto-capture for the best detection results.",
    `Current route: ${mapName}.`
  ].join(" ");

  function handleTranslateGuide() {
    window.open(buildGuideTranslationUrl(language, guideText), "_blank", "noopener,noreferrer");
  }

  return (
    <div className="auto-capture-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="welcome-guide-title">
      <div className="welcome-guide-modal page-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Welcome to FarmTracks</p>
            <h2 id="welcome-guide-title">How the tracker and overlay work</h2>
            <p className="subtle-text">
              This quick start shows how to track runs manually, when auto-capture works, and why the desktop app gives
              the most reliable overlay experience.
            </p>
          </div>
          <div className="overlay-launch-actions">
            {!isDesktopShell ? (
              <a
                className="secondary-button overlay-link-button"
                href={installerUrl}
                onClick={onInstall}
                target="_blank"
                rel="noreferrer"
              >
                Download Desktop App
              </a>
            ) : (
              <button type="button" className="secondary-button" onClick={onLaunchOverlay}>
                Open Overlay
              </button>
            )}
            <button type="button" className="ghost-button" onClick={onClose}>
              Start using FarmTracks
            </button>
          </div>
        </div>

        <div className="welcome-guide-toolbar">
          <label className="welcome-guide-language">
            <span>Translate instructions</span>
            <select value={language} onChange={(event) => onLanguageChange(event.target.value)}>
              {GUIDE_TRANSLATION_LANGUAGES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="ghost-button" onClick={handleTranslateGuide}>
            Open in Google Translate
          </button>
        </div>

        <div className="welcome-guide-grid">
          <article className="welcome-guide-card">
            <p className="eyebrow">Manual Tracking</p>
            <h3>Self-use the tracker in four steps</h3>
            <ol className="overlay-guide-steps">
              <li>Choose your route from the left sidebar.</li>
              <li>Keep farming, then open your bag after each clear.</li>
              <li>Enter the current bag counts and press <code>Capture round</code>.</li>
              <li>Press <code>Finish session</code> when you want to archive the run and start fresh.</li>
            </ol>
          </article>

          <article className="welcome-guide-card">
            <p className="eyebrow">Auto Capture</p>
            <h3>How the smart scan works</h3>
            <ol className="overlay-guide-steps">
              <li>Auto-capture currently works inside the desktop app for Narwashi.</li>
              <li>Press <code>Calibrate</code> once and click one crystal, one arcane, and one speed potion.</li>
              <li><code>Auto-fill</code> reads visible bag slots and fills the counts without saving a round yet.</li>
              <li><code>Auto-capture round</code> reads the bag and records the round automatically when counts increased.</li>
            </ol>
          </article>

          <article className="welcome-guide-card welcome-guide-card-accent">
            <p className="eyebrow">Best Experience</p>
            <h3>Use the desktop app for the flawless overlay</h3>
            <p className="subtle-text">
              The website is perfect for manual tracking, but the installed app gives you the native always-on-top
              overlay, better screen capture support, and the smoothest in-game workflow.
            </p>
            <ul className="welcome-guide-list">
              <li>Keep bags visible while scanning.</li>
              <li>Open the overlay beside your game HUD and leave the dashboard in the background.</li>
            </ul>
          </article>
        </div>
      </div>
    </div>
  );
}

function AutoCapturePanel({
  busy,
  hasProfile,
  lastResult,
  message,
  onAutoCapture,
  onAutoFill,
  onClearCalibration,
  onStartCalibration
}) {
  const debugLines = formatAutoCaptureDebugLines(lastResult);

  return (
    <section className="page-panel auto-capture-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Narwashi Auto Capture</p>
          <h2>Read tracked items from the game screen</h2>
          <p className="subtle-text">
            Calibrate once by clicking a crystal, arcane, and speed potion on a live screenshot. FarmTracks will then
            scan visible bags anywhere on screen and fill the current inventory totals automatically. The desktop app
            now tries AutoHotkey image matching first when it is installed.
          </p>
        </div>
        <div className="auto-capture-actions">
          <button type="button" className="secondary-button" onClick={onStartCalibration} disabled={busy}>
            {hasProfile ? "Recalibrate" : "Calibrate"}
          </button>
          <button type="button" className="ghost-button" onClick={onAutoFill} disabled={!hasProfile || busy}>
            Auto-fill
          </button>
          <button type="button" className="primary-button" onClick={onAutoCapture} disabled={!hasProfile || busy}>
            Auto-capture round
          </button>
        </div>
      </div>

      <div className="auto-capture-meta">
        <span className={`status-pill ${hasProfile ? "" : "offline"}`}>
          {hasProfile ? "Calibration ready" : "Calibration needed"}
        </span>
        {hasProfile ? (
          <button type="button" className="ghost-button auto-capture-clear" onClick={onClearCalibration} disabled={busy}>
            Clear saved calibration
          </button>
        ) : null}
      </div>

      {message ? <p className="helper-text auto-capture-message">{message}</p> : null}

      {lastResult ? (
        <>
          <div className="auto-capture-results">
            <div className="meta-entry">
              <span>Last scan</span>
              <strong>{lastResult.matches.length} matched slots</strong>
            </div>
            <div className="meta-entry">
              <span>Crystals</span>
              <strong>{lastResult.snapshot.crystals}</strong>
            </div>
            <div className="meta-entry">
              <span>Arcanes</span>
              <strong>{lastResult.snapshot.arcanes}</strong>
            </div>
            <div className="meta-entry">
              <span>Speed Potions</span>
              <strong>{lastResult.snapshot["speed-potions"]}</strong>
            </div>
          </div>
          {debugLines.length ? (
            <div className="auto-capture-debug">
              {debugLines.map((line) => (
                <p key={line} className="helper-text auto-capture-debug-line">
                  {line}
                </p>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function AutoCaptureCalibrationModal({ session, onCancel, onRetake, onSelect }) {
  const nextItem = NARWASHI_AUTO_CAPTURE_ITEMS[session.selections.length];

  function getImagePoint(event) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const scaleX = session.imageWidth / bounds.width;
    const scaleY = session.imageHeight / bounds.height;
    return {
      x: Math.round((event.clientX - bounds.left) * scaleX),
      y: Math.round((event.clientY - bounds.top) * scaleY)
    };
  }

  function handleImageClick(event) {
    const { x, y } = getImagePoint(event);
    onSelect({ itemId: nextItem.id, x, y });
  }

  return (
    <div className="auto-capture-modal-backdrop" role="dialog" aria-modal="true">
      <div className="auto-capture-modal page-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Calibration</p>
            <h2>Click the {nextItem.name} icon</h2>
            <p className="subtle-text">
              Click the center of one visible {nextItem.shortName.toLowerCase()} slot. FarmTracks will find the open
              bag grids automatically when scanning.
            </p>
          </div>
          <div className="auto-capture-actions">
            <button type="button" className="secondary-button" onClick={onRetake}>
              Retake screenshot
            </button>
            <button type="button" className="ghost-button" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>

        <div className="auto-capture-selection-list">
          {NARWASHI_AUTO_CAPTURE_ITEMS.map((item, index) => {
            const selection = session.selections[index];
            return (
              <span key={item.id} className={`status-pill ${selection ? "" : "offline"}`}>
                {selection ? `${index + 1}. ${item.name} saved` : `${index + 1}. Click ${item.name}`}
              </span>
            );
          })}
        </div>

        <div className="auto-capture-image-shell">
          <img
            src={session.screenshotDataUrl}
            alt="Game screenshot for auto-capture calibration"
            className="auto-capture-image"
            onClick={handleImageClick}
          />
          {session.selections.map((selection, index) => (
            <span
              key={`${selection.itemId}-${index}`}
              className="auto-capture-marker"
              style={{
                left: `${(selection.x / session.imageWidth) * 100}%`,
                top: `${(selection.y / session.imageHeight) * 100}%`
              }}
            >
              {index + 1}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function CapturePanel({
  formMessage,
  handleCaptureRound,
  handleInventoryChange,
  inventoryInputs,
  isDesktopShell,
  isOverlayMode,
  onOpenOverlay,
  projectedRoundGain,
  roundGains,
  selectedMap,
  selectedSession,
  nextRoundNumber
}) {
  return (
    <form className={`page-panel capture-panel ${isOverlayMode ? "capture-panel-overlay" : ""}`} onSubmit={handleCaptureRound}>
      <div className="panel-header">
        <div>
          <h2>Capture Current Inventory</h2>
          <p className="subtle-text">
            Enter current stack counts after each route clear. FarmTracks calculates the round gain.
          </p>
        </div>
        <div className="capture-panel-actions">
          {!isOverlayMode ? (
            <button type="button" className="ghost-button" onClick={onOpenOverlay}>
              {isDesktopShell ? "Open overlay" : "Open pop-out"}
            </button>
          ) : null}
        </div>
      </div>

      {isOverlayMode ? (
        <div className="overlay-banner">
          <strong>{selectedMap.name}</strong>
          <span>Keep this window beside the game and pin it with your OS if needed.</span>
        </div>
      ) : null}

      <div className="checkpoint-grid">
        {selectedMap.items.map((item) => (
          <div key={item.id} className="checkpoint-card">
            <div className="checkpoint-copy">
              <strong>{item.name}</strong>
              <span>
                Saved bag state: {splitAmount(selectedSession?.currentSnapshot?.[item.id] ?? 0).stacks} stacks,
                {" "}
                {splitAmount(selectedSession?.currentSnapshot?.[item.id] ?? 0).loose} loose
              </span>
            </div>

            <div className="checkpoint-fields">
              <label>
                <span>Stacks</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={inventoryInputs[item.id]?.stacks ?? ""}
                  onChange={(event) => handleInventoryChange(item.id, "stacks", event.target.value)}
                  placeholder="0"
                />
              </label>
              <label>
                <span>Current in Bag</span>
                <input
                  type="number"
                  min="0"
                  max={STACK_SIZE - 1}
                  step="1"
                  value={inventoryInputs[item.id]?.loose ?? ""}
                  onChange={(event) => handleInventoryChange(item.id, "loose", event.target.value)}
                  placeholder="0"
                />
              </label>
            </div>
          </div>
        ))}
      </div>

      <div className="capture-footer">
        <div>
          <p className="helper-text">
            {projectedRoundGain > 0
              ? `This checkpoint will record +${projectedRoundGain} items for round ${nextRoundNumber}.`
              : "Increase at least one count to capture a new round."}
          </p>
          {formMessage ? <p className="feedback-text">{formMessage}</p> : null}
        </div>
        <button type="submit" className="primary-button" disabled={!hasPositiveGain(roundGains)}>
          Capture round
        </button>
      </div>
    </form>
  );
}

function normalizePlayersForSingleSession(players) {
  if (!Array.isArray(players) || players.length === 0) {
    return [createNewPlayer("Local Session")];
  }

  const primaryPlayer = structuredClone(players[0]);
  primaryPlayer.name = "Local Session";

  return [primaryPlayer];
}

function ScannerStatusPanel({
  isRunning,
  latestSnapshot,
  pendingGains,
  lastScanAt,
  scannerError,
  onStart,
  onStop,
  onResetPending,
  onEndRound,
}) {
  const lastScanLabel = lastScanAt ? new Date(lastScanAt).toLocaleTimeString() : "—";

  return (
    <section className="page-panel auto-capture-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Python Scanner</p>
          <h2>Background inventory scanner</h2>
          <p className="subtle-text">
            Scans every 2–3 s. F7 toggle overlay · F8 reset baseline · F9 save round.
          </p>
        </div>
        <div className="auto-capture-actions">
          {isRunning ? (
            <button type="button" className="ghost-button" onClick={onStop}>Stop</button>
          ) : (
            <button type="button" className="secondary-button" onClick={onStart}>Start</button>
          )}
          <button type="button" className="ghost-button" onClick={onResetPending} disabled={!isRunning}>Reset (F8)</button>
          <button type="button" className="primary-button" onClick={onEndRound} disabled={!latestSnapshot}>End round (F9)</button>
        </div>
      </div>

      <div className="auto-capture-meta">
        <span className={`status-pill ${isRunning ? "" : "offline"}`}>{isRunning ? "Active" : "Stopped"}</span>
        <span className="helper-text">Last scan: {lastScanLabel}</span>
      </div>

      {scannerError ? <p className="feedback-text">{scannerError}</p> : null}

      {latestSnapshot ? (
        <div className="auto-capture-results">
          <div className="meta-entry"><span>Crystals</span><strong>{latestSnapshot.crystals ?? 0}{pendingGains ? ` (+${Math.max(0, pendingGains.crystals ?? 0)})` : ""}</strong></div>
          <div className="meta-entry"><span>Arcanes</span><strong>{latestSnapshot.arcanes ?? 0}{pendingGains ? ` (+${Math.max(0, pendingGains.arcanes ?? 0)})` : ""}</strong></div>
          <div className="meta-entry"><span>Potions</span><strong>{latestSnapshot["speed-potions"] ?? 0}{pendingGains ? ` (+${Math.max(0, pendingGains["speed-potions"] ?? 0)})` : ""}</strong></div>
        </div>
      ) : null}
    </section>
  );
}

function HotkeySettingsModal({ hotkeys, onSave, onClose }) {
  const [editing, setEditing] = useState({ ...hotkeys });
  const [binding, setBinding] = useState(null); // which key is being rebound

  function startBinding(field) {
    setBinding(field);
  }

  useEffect(() => {
    if (!binding) return;
    function onKeyDown(e) {
      e.preventDefault();
      const key = e.key === " " ? "Space" : e.key;
      setEditing((prev) => ({ ...prev, [binding]: key }));
      setBinding(null);
    }
    window.addEventListener("keydown", onKeyDown, { once: true });
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [binding]);

  const LABELS = { toggleOverlay: "Toggle overlay", resetPending: "Reset baseline", endRound: "End round" };

  return (
    <div className="overlay-settings-backdrop" onClick={onClose}>
      <div className="overlay-settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="overlay-settings-header">
          <strong>Hotkey Settings</strong>
          <button type="button" className="overlay-icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="overlay-settings-body">
          {Object.entries(LABELS).map(([field, label]) => (
            <div key={field} className="overlay-hotkey-row">
              <span className="overlay-hotkey-label">{label}</span>
              <button
                type="button"
                className={`overlay-hotkey-bind ${binding === field ? "listening" : ""}`}
                onClick={() => startBinding(field)}
              >
                {binding === field ? "Press a key…" : (editing[field] || "—")}
              </button>
            </div>
          ))}
        </div>
        <div className="overlay-settings-footer">
          <button type="button" className="overlay-action-btn secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="overlay-action-btn primary" onClick={() => onSave(editing)}>Save</button>
        </div>
      </div>
    </div>
  );
}

function OverlayScannerPanel({
  isRunning,
  latestSnapshot,
  pendingGains,
  lastScanAt,
  scannerError,
  onStart,
  onStop,
  onResetPending,
  onResetToZero,
  onEndRound,
  selectedMap,
  selectedSession,
  nextRoundNumber,
  formMessage,
  resetConfirmMsg,
  ocrSetupMsg,
  inventoryInputs,
  onInventoryChange,
  onCaptureRound,
  roundGains,
  hotkeys,
  onSaveHotkeys,
  scanRegion,
  onSetBagArea,
  onClearBagArea,
}) {
  const [showManual, setShowManual] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const lastScanLabel = lastScanAt ? new Date(lastScanAt).toLocaleTimeString() : "—";
  const sessionTotal = getTotalItems(selectedSession?.totals ?? {});
  const canCaptureManual = hasPositiveGain(roundGains);

  const hk = hotkeys || { toggleOverlay: "F7", resetPending: "F8", endRound: "F9" };

  return (
    <>
      <div className="overlay-scanner-panel">
        <div className="overlay-scanner-status">
          <span className={`status-pill ${isRunning ? "" : "offline"}`}>
            {isRunning ? "Scanning" : "Stopped"}
          </span>
          <span className="overlay-scan-time">{lastScanLabel}</span>
          {isRunning ? (
            <button type="button" className="ghost-button overlay-scanner-toggle" onClick={onStop}>Stop</button>
          ) : (
            <button type="button" className="ghost-button overlay-scanner-toggle" onClick={onStart}>Start</button>
          )}
          <button type="button" className="overlay-icon-btn" onClick={() => setShowSettings(true)} title="Hotkey settings">⚙</button>
        </div>

        {scannerError ? (
          <p className="feedback-text overlay-scanner-error">{scannerError}</p>
        ) : null}

        {ocrSetupMsg ? (
          <p className="overlay-ocr-setup-msg">{ocrSetupMsg}</p>
        ) : null}

        <div className="overlay-item-grid">
          {latestSnapshot ? (
            <>
              <div className="overlay-item-row">
                <span className="overlay-item-name">Crystals</span>
                <span className="overlay-item-count">{latestSnapshot.crystals ?? 0}</span>
                <span className="overlay-item-gain">+{Math.max(0, pendingGains?.crystals ?? 0)}</span>
              </div>
              <div className="overlay-item-row">
                <span className="overlay-item-name">Arcanes</span>
                <span className="overlay-item-count">{latestSnapshot.arcanes ?? 0}</span>
                <span className="overlay-item-gain">+{Math.max(0, pendingGains?.arcanes ?? 0)}</span>
              </div>
              <div className="overlay-item-row">
                <span className="overlay-item-name">Potions</span>
                <span className="overlay-item-count">{latestSnapshot["speed-potions"] ?? 0}</span>
                <span className="overlay-item-gain">+{Math.max(0, pendingGains?.["speed-potions"] ?? 0)}</span>
              </div>
            </>
          ) : (
            <p className="overlay-scanner-waiting">Waiting for first scan…</p>
          )}
        </div>

        <div className="overlay-scanner-actions">
          <button
            type="button"
            className="overlay-action-btn secondary"
            onClick={onResetPending}
            disabled={!isRunning}
            title={`Reset pending baseline (${hk.resetPending})`}
          >
            Reset <kbd>{hk.resetPending}</kbd>
          </button>
          <button
            type="button"
            className="overlay-action-btn primary"
            onClick={onEndRound}
            disabled={!latestSnapshot}
            title={`Save round (${hk.endRound})`}
          >
            End Round <kbd>{hk.endRound}</kbd>
          </button>
        </div>

        <div className="overlay-reset-row">
          <button
            type="button"
            className="overlay-zero-btn"
            onClick={onResetToZero}
            disabled={!isRunning}
            title="Set baseline to zero — gains will count up from 0"
          >
            Count from zero
          </button>
          {resetConfirmMsg ? <span className="overlay-reset-confirm">{resetConfirmMsg}</span> : null}
        </div>

        {formMessage ? <p className="overlay-form-message">{formMessage}</p> : null}

        <div className="overlay-bag-area-row">
          {scanRegion ? (
            <>
              <span className="overlay-bag-area-set">Bag area set</span>
              <button type="button" className="overlay-zero-btn" onClick={onSetBagArea}>Change</button>
              <button type="button" className="overlay-zero-btn" onClick={onClearBagArea}>Clear</button>
            </>
          ) : (
            <button type="button" className="overlay-bag-area-btn" onClick={onSetBagArea}>
              Set bag area — fix detection
            </button>
          )}
        </div>

        <div className="overlay-session-meta">
          <span>Round {nextRoundNumber}</span>
          <span>{sessionTotal} items this session</span>
          <button
            type="button"
            className="overlay-toggle-manual"
            onClick={() => setShowManual((v) => !v)}
          >
            {showManual ? "Hide manual" : "Manual input"}
          </button>
        </div>

        {showManual ? (
          <form className="overlay-manual-form" onSubmit={(e) => { e.preventDefault(); onCaptureRound(); }}>
            {selectedMap.items.map((item) => (
              <div key={item.id} className="overlay-manual-row">
                <span className="overlay-manual-name">{item.name}</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  placeholder="Stacks"
                  value={inventoryInputs[item.id]?.stacks ?? ""}
                  onChange={(e) => onInventoryChange(item.id, "stacks", e.target.value)}
                  className="overlay-manual-input"
                />
                <input
                  type="number"
                  min="0"
                  max={STACK_SIZE - 1}
                  step="1"
                  placeholder="Loose"
                  value={inventoryInputs[item.id]?.loose ?? ""}
                  onChange={(e) => onInventoryChange(item.id, "loose", e.target.value)}
                  className="overlay-manual-input"
                />
              </div>
            ))}
            <button
              type="submit"
              className="overlay-action-btn primary"
              style={{ width: "100%", marginTop: 6 }}
              disabled={!canCaptureManual}
            >
              Capture round manually
            </button>
          </form>
        ) : null}
      </div>

      {showSettings ? (
        <HotkeySettingsModal
          hotkeys={hk}
          onSave={(next) => { onSaveHotkeys(next); setShowSettings(false); }}
          onClose={() => setShowSettings(false)}
        />
      ) : null}
    </>
  );
}

function RoundTrendChart({ history }) {
  const points = [...history].reverse().map((entry) => getTotalItems(entry.gains));
  const maxValue = Math.max(...points, 1);

  if (points.length === 0) {
    return <p className="empty-state">Round gain history will appear after the first checkpoint is captured.</p>;
  }

  return (
    <div className="chart-shell">
      <div className="chart-bars" aria-label="Round gain chart">
        {points.map((value, index) => (
          <div key={`${index}-${value}`} className="chart-column">
            <div
              className="chart-bar"
              style={{ height: `${Math.max(18, (value / maxValue) * 100)}%` }}
              title={`Round ${index + 1}: ${value} items`}
            />
            <span>R{index + 1}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function App() {
  const isOverlayMode = useMemo(
    () => new URLSearchParams(window.location.search).has(INVENTORY_POPOUT_QUERY),
    []
  );
  const [players, setPlayers] = useState(() => normalizePlayersForSingleSession(loadPlayers()));
  const [selectedPlayerId, setSelectedPlayerId] = useState("");
  const [selectedMapId, setSelectedMapId] = useState(() => {
    const requestedMapId = getRequestedMapId();
    const storedMapId = loadUiState().selectedMapId;
    if (MAPS.some((map) => map.id === requestedMapId)) {
      return requestedMapId;
    }

    return MAPS.some((map) => map.id === storedMapId) ? storedMapId : DEFAULT_MAP_ID;
  });
  const [inventoryInputs, setInventoryInputs] = useState({});
  const [storageError, setStorageError] = useState("");
  const [formMessage, setFormMessage] = useState("");
  const [overlayGuideMode, setOverlayGuideMode] = useState("");
  const [overlayOpacity, setOverlayOpacity] = useState(78);
  const [autoCaptureProfile, setAutoCaptureProfile] = useState(() => loadNarwashiAutoCaptureProfile());
  const [autoCaptureBusy, setAutoCaptureBusy] = useState(false);
  const [autoCaptureMessage, setAutoCaptureMessage] = useState("");
  const [autoCaptureResult, setAutoCaptureResult] = useState(null);
  const [calibrationSession, setCalibrationSession] = useState(null);
  const [guideLanguage, setGuideLanguage] = useState(() => loadUiState().guideLanguage || "en");
  const [showWelcomeGuide, setShowWelcomeGuide] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }

    const uiState = loadUiState();
    return !new URLSearchParams(window.location.search).has(INVENTORY_POPOUT_QUERY) && uiState.seenOnboardingVersion !== ONBOARDING_VERSION;
  });
  const [apiState, setApiState] = useState({
    loading: true,
    error: "",
    maps: []
  });

  // Python scanner state
  const [scannerLatestSnapshot, setScannerLatestSnapshot] = useState(null);
  const [scannerPendingBaseline, setScannerPendingBaseline] = useState(null);
  const [scannerRunning, setScannerRunning] = useState(false);
  const [scannerError, setScannerError] = useState("");
  const [lastScanAt, setLastScanAt] = useState(null);
  const [resetConfirmMsg, setResetConfirmMsg] = useState("");
  const [ocrSetupMsg, setOcrSetupMsg] = useState("");
  const [scanRegion, setScanRegion] = useState(null);

  // Refs so hotkey handlers always see the latest values despite the [] closure
  const scannerLatestSnapshotRef = useRef(null);
  const handleEndScannerRoundRef = useRef(null);
  const handleResetPendingRoundRef = useRef(null);

  // Hotkeys config (loaded from Electron on mount)
  const [hotkeys, setHotkeys] = useState({ toggleOverlay: "F7", resetPending: "F8", endRound: "F9" });

  const selectedMap = useMemo(
    () => MAPS.find((map) => map.id === selectedMapId) ?? MAPS[0],
    [selectedMapId]
  );

  const selectedPlayer = useMemo(
    () => players.find((player) => player.id === selectedPlayerId) ?? null,
    [players, selectedPlayerId]
  );

  const selectedSession = selectedPlayer?.maps[selectedMap.id] ?? null;
  const metadataMap = apiState.maps.find((map) => map.id === selectedMap.id);
  const roundSnapshot = useMemo(
    () => normalizeRoundInput(selectedMap, inventoryInputs),
    [inventoryInputs, selectedMap]
  );
  const roundGains = useMemo(
    () => getRoundGains(selectedSession?.currentSnapshot ?? {}, roundSnapshot),
    [roundSnapshot, selectedSession]
  );

  useEffect(() => {
    if (players.length === 0) {
      const localPlayer = createNewPlayer("Local Session");
      setPlayers([localPlayer]);
      setSelectedPlayerId(localPlayer.id);
      return;
    }

    if (players.length > 1 || players[0]?.name !== "Local Session") {
      setPlayers(normalizePlayersForSingleSession(players));
      return;
    }

    const error = savePlayers(players);
    setStorageError(error);

    if (!selectedPlayerId && players.length > 0) {
      setSelectedPlayerId(players[0].id);
    }

    if (selectedPlayerId && !players.some((player) => player.id === selectedPlayerId)) {
      setSelectedPlayerId(players[0]?.id ?? "");
    }
  }, [players, selectedPlayerId]);

  useEffect(() => {
    function handleStorage(event) {
      if (event.key === "farmtracks.players.v1") {
        setPlayers(normalizePlayersForSingleSession(loadPlayers()));
      }

      if (event.key === "farmtracks.ui.v1") {
        const nextMapId = loadUiState().selectedMapId;

        if (MAPS.some((map) => map.id === nextMapId)) {
          setSelectedMapId(nextMapId);
        }
      }
    }

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  useEffect(() => {
    let ignore = false;

    async function fetchMetadata() {
      try {
        const response = await fetch("/api/metadata");

        if (!response.ok) {
          throw new Error(`Metadata request failed with ${response.status}`);
        }

        const payload = await response.json();

        if (!ignore) {
          setApiState({
            loading: false,
            error: "",
            maps: Array.isArray(payload.maps) ? payload.maps : []
          });
        }
      } catch (error) {
        if (!ignore) {
          setApiState({
            loading: false,
            error: error.message,
            maps: []
          });
        }
      }
    }

    fetchMetadata();

    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    setInventoryInputs(buildInventoryInputs(selectedMap, selectedSession?.currentSnapshot));
    setFormMessage("");
  }, [selectedMapId, selectedPlayerId, selectedSession?.rounds]);

  useEffect(() => {
    saveUiState({ selectedMapId });
  }, [selectedMapId]);

  useEffect(() => {
    saveUiState({ guideLanguage });
  }, [guideLanguage]);

  useEffect(() => {
    scannerLatestSnapshotRef.current = scannerLatestSnapshot;
  }, [scannerLatestSnapshot]);

  useEffect(() => {
    if (!isDesktopShellAvailable()) return;

    const unsubUpdate = window.farmtracksDesktop.onScannerUpdate((payload) => {
      if (payload.type === "scan" && payload.ok && payload.snapshot) {
        setScannerRunning(true);
        setScannerError("");
        setScannerLatestSnapshot(payload.snapshot);
        setLastScanAt(payload.debug?.timestamp ?? new Date().toISOString());
        setScannerPendingBaseline((prev) => prev ?? payload.snapshot);
      } else if (payload.type === "error") {
        setScannerError(payload.message ?? "Scanner error");
      } else if (payload.type === "status") {
        if (payload.status === "stopped") setScannerRunning(false);
        if (payload.status === "ready" || payload.status === "starting") setScannerRunning(true);
      }
    });

    const unsubHotkey = window.farmtracksDesktop.onScannerHotkey((payload) => {
      if (payload.action === "reset-pending") {
        handleResetPendingRoundRef.current?.();
      }
      if (payload.action === "end-round") {
        handleEndScannerRoundRef.current?.();
      }
    });

    // Load saved hotkeys and subscribe to changes
    window.farmtracksDesktop.getHotkeys().then((hk) => {
      if (hk) setHotkeys(hk);
    }).catch(() => {});

    const unsubHotkeys = window.farmtracksDesktop.onHotkeysUpdated((hk) => {
      setHotkeys(hk);
    });

    window.farmtracksDesktop.getScanRegion?.().then((r) => setScanRegion(r ?? null)).catch(() => {});
    const unsubRegion = window.farmtracksDesktop.onScanRegionUpdated?.((r) => setScanRegion(r ?? null)) ?? (() => {});

    const unsubOcr = window.farmtracksDesktop.onOcrSetup?.((payload) => {
      if (payload.status === "done") {
        setOcrSetupMsg("");
      } else if (payload.status === "downloading" || payload.status === "installing") {
        setOcrSetupMsg(payload.message ?? "Setting up OCR…");
      } else {
        setOcrSetupMsg(""); // error: silent, scanner just shows 1s
      }
    }) ?? (() => {});

    return () => {
      unsubUpdate();
      unsubHotkey();
      unsubHotkeys();
      unsubOcr();
      unsubRegion();
    };
  }, []);

  const nextRoundNumber = (selectedSession?.rounds ?? 0) + 1;
  const sessionTotal = getTotalItems(selectedSession?.totals ?? {});
  const activeSnapshotTotal = getTotalItems(selectedSession?.currentSnapshot ?? {});
  const projectedRoundGain = getTotalItems(
    Object.fromEntries(Object.entries(roundGains).map(([itemId, value]) => [itemId, Math.max(0, value)]))
  );
  const completedSessions = selectedSession?.sessions.length ?? 0;
  const allLiveRounds = selectedPlayer
    ? Object.values(selectedPlayer.maps).reduce((sum, mapState) => sum + mapState.rounds, 0)
    : 0;
  const mapSnapshot = splitAmount(activeSnapshotTotal);
  const isDesktopShell = isDesktopShellAvailable();
  const isNarwashiAutoCaptureAvailable = isDesktopShell && selectedMap.id === "narwashi";

  const scannerPendingGains = useMemo(() => {
    if (!scannerLatestSnapshot || !scannerPendingBaseline) return null;
    return getRoundGains(scannerPendingBaseline, scannerLatestSnapshot);
  }, [scannerLatestSnapshot, scannerPendingBaseline]);

  function handleInventoryChange(itemId, field, nextValue) {
    setInventoryInputs((current) => ({
      ...current,
      [itemId]: {
        ...current[itemId],
        [field]: nextValue
      }
    }));
    setFormMessage("");
  }

  function applySnapshot(snapshotTotals, sourceLabel) {
    if (!selectedPlayer || !selectedSession) {
      return false;
    }

    const nextRoundGains = getRoundGains(selectedSession.currentSnapshot ?? {}, snapshotTotals);

    if (hasNegativeGain(nextRoundGains)) {
      setFormMessage(`Auto-capture found lower counts than the current saved bag state. Review the scan before recording ${sourceLabel}.`);
      return false;
    }

    if (!hasPositiveGain(nextRoundGains)) {
      setFormMessage(`No new gains were found for ${sourceLabel}.`);
      return false;
    }

    setPlayers((currentPlayers) =>
      currentPlayers.map((player) =>
        player.id === selectedPlayer.id ? applyRound(player, selectedMap.id, snapshotTotals) : player
      )
    );
    setInventoryInputs(buildInventoryInputs(selectedMap, snapshotTotals));
    setFormMessage(`Round ${nextRoundNumber} captured from ${sourceLabel}.`);
    return true;
  }

  function handleOpenOverlay() {
    if (isDesktopShell) {
      setOverlayGuideMode("desktop");
      window.farmtracksDesktop.openOverlayWindow();
      return;
    }

    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set(INVENTORY_POPOUT_QUERY, "1");

    const popup = window.open(
      nextUrl.toString(),
      "farmtracks-capture-overlay",
      "popup=yes,width=560,height=860,resizable=yes,scrollbars=yes"
    );

    popup?.focus();
  }

  function handleInstallOverlay(event) {
    setOverlayGuideMode("install");

    if (!OVERLAY_INSTALLER_URL) {
      event.preventDefault();
    }
  }

  function handleLaunchOverlayApp() {
    if (isDesktopShell) {
      setOverlayGuideMode("desktop");
      window.farmtracksDesktop.openOverlayWindow();
      return;
    }

    setOverlayGuideMode("launch");
    triggerDesktopProtocol(getProtocolLaunchUrl(selectedMapId));
  }

  function handleDismissWelcomeGuide() {
    setShowWelcomeGuide(false);
    saveUiState({ seenOnboardingVersion: ONBOARDING_VERSION });
  }

  function handleCloseOverlay() {
    if (isDesktopShell) {
      window.farmtracksDesktop.closeCurrentWindow();
      return;
    }

    window.close();
  }

  function handleOpenMainWindow() {
    if (!isDesktopShell) {
      return;
    }

    window.farmtracksDesktop.openMainWindow();
  }

  async function handleOverlayOpacityChange(nextOpacity) {
    setOverlayOpacity(nextOpacity);

    if (!isDesktopShell || !isOverlayMode) {
      return;
    }

    const appliedOpacity = await window.farmtracksDesktop.setOverlayOpacity(nextOpacity / 100);
    setOverlayOpacity(Math.round(appliedOpacity * 100));
  }

  function handleCaptureRound(event) {
    event.preventDefault();
    applySnapshot(roundSnapshot, "the latest inventory checkpoint");
  }

  function handleFinishSession() {
    if (!selectedPlayer || !selectedSession || selectedSession.rounds === 0) {
      return;
    }

    setPlayers((currentPlayers) =>
      currentPlayers.map((player) =>
        player.id === selectedPlayer.id ? finishSession(player, selectedMap.id, selectedMap.items) : player
      )
    );
    setFormMessage(`Session finished for ${selectedPlayer.name}. A fresh session is ready.`);
  }

  function handleResetSession() {
    if (!selectedPlayer) {
      return;
    }

    setPlayers((currentPlayers) =>
      currentPlayers.map((player) =>
        player.id === selectedPlayer.id
          ? resetMapProgress(player, selectedMap.id, selectedMap.items)
          : player
      )
    );
    setFormMessage(`Current session reset for ${selectedPlayer.name}.`);
  }

  async function handleStartAutoCaptureCalibration() {
    setAutoCaptureBusy(true);
    setAutoCaptureMessage("");

    try {
      const screenshotDataUrl = await captureDesktopScreenshot({ hideCurrentWindow: true });
      const screenshotImage = new Image();
      screenshotImage.src = screenshotDataUrl;
      await screenshotImage.decode();

      setCalibrationSession({
        screenshotDataUrl,
        imageWidth: screenshotImage.width,
        imageHeight: screenshotImage.height,
        selections: []
      });
    } catch (error) {
      setAutoCaptureMessage(error instanceof Error ? error.message : "Unable to capture the screen for calibration.");
    } finally {
      setAutoCaptureBusy(false);
    }
  }

  async function handleRetakeAutoCaptureCalibration() {
    await handleStartAutoCaptureCalibration();
  }

  async function handleSelectCalibrationPoint(selection) {
    if (!calibrationSession) {
      return;
    }

    const nextSelections = [...calibrationSession.selections, selection];

    if (nextSelections.length < NARWASHI_AUTO_CAPTURE_ITEMS.length) {
      setCalibrationSession({
        ...calibrationSession,
        selections: nextSelections
      });
      return;
    }

    setAutoCaptureBusy(true);

    try {
      const nextProfile = await createNarwashiAutoCaptureProfile({
        screenshotDataUrl: calibrationSession.screenshotDataUrl,
        selections: nextSelections
      });

      setAutoCaptureProfile(nextProfile);
      setCalibrationSession(null);
      setAutoCaptureResult(null);
      setAutoCaptureMessage("Calibration saved. You can now auto-fill or auto-capture Narwashi rounds.");
    } catch (error) {
      setAutoCaptureMessage(error instanceof Error ? error.message : "Unable to save auto-capture calibration.");
    } finally {
      setAutoCaptureBusy(false);
    }
  }

  function handleClearAutoCaptureCalibration() {
    clearNarwashiAutoCaptureProfile();
    setAutoCaptureProfile(null);
    setAutoCaptureResult(null);
    setAutoCaptureMessage("Saved Narwashi calibration cleared.");
  }

  async function runNarwashiAutoCapture(autoSubmit) {
    setAutoCaptureBusy(true);
    setAutoCaptureMessage("");

    try {
      const result = await scanNarwashiScreen(autoCaptureProfile, { hideCurrentWindow: true });
      const mergedSnapshot = mergeWithCurrentSnapshot(selectedMap, selectedSession?.currentSnapshot, result.snapshot);
      const mergedResult = { ...result, snapshot: mergedSnapshot };
      const providerLabel = result.provider === "autohotkey" ? "using AutoHotkey image matching" : "using the built-in scanner";
      const summary = `Detected ${mergedSnapshot.crystals} crystals, ${mergedSnapshot.arcanes} arcanes, and ${mergedSnapshot["speed-potions"]} speed potions from ${result.matches.length} matched slots ${providerLabel}.`;

      setAutoCaptureResult(mergedResult);
      setInventoryInputs(buildInventoryInputs(selectedMap, mergedSnapshot));

      if (autoSubmit) {
        const captured = applySnapshot(mergedSnapshot, "auto-capture");
        setAutoCaptureMessage(captured ? `${summary} Round recorded automatically.` : `${summary} Review the filled values before capturing.`);
      } else {
        setAutoCaptureMessage(`${summary} Review the filled values or press Auto-capture round.`);
      }
    } catch (error) {
      setAutoCaptureMessage(error instanceof Error ? error.message : "Auto-capture failed.");
    } finally {
      setAutoCaptureBusy(false);
    }
  }

  function handleStartScanner() {
    if (isDesktopShell) {
      window.farmtracksDesktop.startScanner();
      setScannerRunning(true);
    }
  }

  function handleStopScanner() {
    if (isDesktopShell) {
      window.farmtracksDesktop.stopScanner();
      setScannerRunning(false);
    }
  }

  function handleResetPendingRound() {
    setScannerPendingBaseline(scannerLatestSnapshotRef.current);
    setResetConfirmMsg("Baseline reset ✓");
    setTimeout(() => setResetConfirmMsg(""), 2000);
  }

  function handleResetToZero() {
    setScannerPendingBaseline({ crystals: 0, arcanes: 0, "speed-potions": 0 });
    setResetConfirmMsg("Counting from zero ✓");
    setTimeout(() => setResetConfirmMsg(""), 2000);
  }

  function handleEndScannerRound() {
    const latest = scannerLatestSnapshotRef.current;
    if (!latest || !selectedPlayer) return;

    const hasGains = scannerPendingGains && Object.values(scannerPendingGains).some((v) => v > 0);
    if (!hasGains) {
      setFormMessage("No positive gains detected since the last baseline. Press Reset baseline (F8) first.");
      return;
    }

    const captured = applySnapshot(latest, "Python scanner");
    if (captured) {
      setScannerPendingBaseline(latest);
    }
  }

  // Keep refs current on every render so hotkey closures always call the latest version
  handleEndScannerRoundRef.current = handleEndScannerRound;
  handleResetPendingRoundRef.current = handleResetPendingRound;

  function handleSetBagArea() {
    if (!isDesktopShell) return;
    window.farmtracksDesktop.openRegionSelector();
  }

  function handleClearBagArea() {
    if (!isDesktopShell) return;
    window.farmtracksDesktop.clearScanRegion();
  }

  function handleSaveHotkeys(next) {
    if (isDesktopShell) {
      window.farmtracksDesktop.setHotkeys(next);
    } else {
      setHotkeys(next);
    }
  }

  if (isOverlayMode) {
    return (
      <main className="overlay-shell overlay-shell-compact">
        <header className="overlay-compact-header">
          <div className="overlay-compact-drag">
            <span className="overlay-compact-title">FarmTracks</span>
            <span className="overlay-compact-map">{selectedMap.name}</span>
          </div>
          <div className="overlay-compact-controls">
            <label className="overlay-opacity-mini" title="Opacity">
              <input
                type="range"
                min="45"
                max="100"
                step="1"
                value={overlayOpacity}
                onChange={(e) => handleOverlayOpacityChange(Number(e.target.value))}
              />
            </label>
            {isDesktopShell ? (
              <button type="button" className="overlay-icon-btn" onClick={handleOpenMainWindow} title="Open dashboard">⊞</button>
            ) : null}
            <button type="button" className="overlay-icon-btn" onClick={handleCloseOverlay} title="Close">✕</button>
          </div>
        </header>

        <div className="overlay-map-tabs" role="tablist">
          {MAPS.map((map) => (
            <button
              key={map.id}
              type="button"
              role="tab"
              aria-selected={map.id === selectedMapId}
              className={`overlay-map-tab ${map.id === selectedMapId ? "active" : ""}`}
              onClick={() => setSelectedMapId(map.id)}
            >
              {map.name}
            </button>
          ))}
        </div>

        {selectedPlayer ? (
          <OverlayScannerPanel
            isRunning={scannerRunning}
            latestSnapshot={scannerLatestSnapshot}
            pendingGains={scannerPendingGains}
            lastScanAt={lastScanAt}
            scannerError={scannerError}
            onStart={handleStartScanner}
            onStop={handleStopScanner}
            onResetPending={handleResetPendingRound}
            onResetToZero={handleResetToZero}
            onEndRound={handleEndScannerRound}
            selectedMap={selectedMap}
            selectedSession={selectedSession}
            nextRoundNumber={nextRoundNumber}
            formMessage={formMessage}
            resetConfirmMsg={resetConfirmMsg}
            ocrSetupMsg={ocrSetupMsg}
            inventoryInputs={inventoryInputs}
            onInventoryChange={handleInventoryChange}
            onCaptureRound={() => applySnapshot(normalizeRoundInput(selectedMap, inventoryInputs), "manual input")}
            roundGains={roundGains}
            hotkeys={hotkeys}
            onSaveHotkeys={handleSaveHotkeys}
            scanRegion={scanRegion}
            onSetBagArea={handleSetBagArea}
            onClearBagArea={handleClearBagArea}
          />
        ) : (
          <p className="overlay-scanner-waiting">Preparing session…</p>
        )}
      </main>
    );
  }

  const preferredMapDetails = apiState.maps.find((map) => map.id === selectedMap.id);
  const overlayGuideContent = overlayGuideMode
    ? {
        install: {
          eyebrow: "Download started",
          title: "Install the Windows overlay",
          steps: [
            "Your browser should start downloading the FarmTracks Overlay installer.",
            "If Windows SmartScreen appears, press 'More info' and then 'Run anyway' because the installer is not code-signed yet.",
            "Finish setup and leave 'Launch FarmTracks Overlay' enabled so the desktop app registers the farmtracks:// link."
          ]
        },
        launch: {
          eyebrow: "Launch requested",
          title: `Opening ${selectedMap.name} in the overlay`,
          steps: [
            "Approve the browser or Windows prompt to open FarmTracks Overlay.",
            "If nothing opens, install the overlay first and launch it once manually.",
            "After that, the website can reopen the native overlay directly from this page."
          ]
        },
        desktop: {
          eyebrow: "Desktop mode",
          title: "Native overlay ready",
          steps: [
            `Open the always-on-top panel for ${selectedMap.name}.`,
            "Keep the overlay near your game HUD while the desktop app handles scanning and manual corrections.",
            "Close it anytime and reopen it from the launcher or this page."
          ]
        }
      }[overlayGuideMode]
    : null;

  return (
    <div className="landing-shell">
      <header className="landing-topbar">
        <a className="landing-brand" href="https://vision4s.com/" target="_blank" rel="noreferrer">
          <img src="/vision4-assets/vision4-logo.png" alt="4Vision" className="brand-logo" />
          <span>FarmTracks Overlay</span>
        </a>
        <div className="landing-topbar-meta">
          <span className={`live-indicator ${apiState.error ? "offline" : ""}`}>
            {apiState.loading ? "Syncing route data" : apiState.error ? "Offline metadata" : "Route data ready"}
          </span>
          <a className="landing-inline-link" href="#download">Download</a>
        </div>
      </header>

      <main className="landing-main">
        <section className="landing-hero">
          <div className="landing-hero-copy">
            <p className="eyebrow">4Vision Farming Toolkit</p>
            <h1>The website introduces FarmTracks. The overlay does the work.</h1>
            <p className="landing-lede">
              FarmTracks is now centered around a native Windows overlay for scanning, manual corrections,
              and always-on-top in-game tracking. The web app becomes the launchpad: learn what it does,
              pick your route, and install or open the overlay in one click.
            </p>

            <div className="landing-hero-actions">
              <a
                className="primary-button landing-cta"
                href={OVERLAY_INSTALLER_URL}
                onClick={handleInstallOverlay}
                target="_blank"
                rel="noreferrer"
              >
                Download Overlay for Windows
              </a>
              <button type="button" className="secondary-button landing-cta" onClick={handleLaunchOverlayApp}>
                {isDesktopShell ? "Open Overlay" : "Launch Installed Overlay"}
              </button>
            </div>

            <div className="landing-hero-notes">
              <span>Always-on-top overlay window</span>
              <span>Scanner + manual input inside the app</span>
              <span>Route-aware launch with deep links</span>
            </div>
          </div>

          <div className="landing-hero-panel">
            <div className="landing-orb" />
            <div className="landing-preview-card">
              <span className="landing-preview-kicker">Preferred route</span>
              <strong>{selectedMap.name}</strong>
              <p>{preferredMapDetails?.notes ?? selectedMap.note}</p>
              <div className="landing-route-pills">
                {selectedMap.items.map((item) => (
                  <span key={item.id}>{item.name}</span>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="landing-section">
          <div className="landing-section-heading">
            <p className="eyebrow">Why the change</p>
            <h2>The browser no longer needs to be the dashboard</h2>
          </div>

          <div className="landing-feature-grid">
            <article className="landing-feature-card">
              <h3>Overlay-first workflow</h3>
              <p>The native app keeps scanning, hotkeys, and manual round saves where they belong: beside the game.</p>
            </article>
            <article className="landing-feature-card">
              <h3>Cleaner public website</h3>
              <p>This site can focus on onboarding, explaining the product, and getting players into the overlay quickly.</p>
            </article>
            <article className="landing-feature-card">
              <h3>Fewer moving parts in browser</h3>
              <p>No more asking the website to behave like an in-game tool when the desktop overlay already does that better.</p>
            </article>
          </div>
        </section>

        <section className="landing-section" id="download">
          <div className="landing-section-heading">
            <p className="eyebrow">Download & Launch</p>
            <h2>Install once, then reopen FarmTracks from the website anytime</h2>
          </div>

          <div className="landing-download-grid">
            <article className="landing-download-card landing-download-card-primary">
              <span className="landing-card-kicker">Windows overlay app</span>
              <h3>FarmTracks Overlay Setup</h3>
              <p>
                Download the desktop app for the full experience: overlay window, capture scanner,
                hotkeys, and map-aware launch links.
              </p>
              <div className="landing-download-actions">
                <a
                  className="primary-button landing-cta"
                  href={OVERLAY_INSTALLER_URL}
                  onClick={handleInstallOverlay}
                  target="_blank"
                  rel="noreferrer"
                >
                  Download Installer
                </a>
                <button type="button" className="ghost-button landing-cta" onClick={handleLaunchOverlayApp}>
                  Open Installed Overlay
                </button>
              </div>
              <ol className="landing-step-list">
                <li>Download and run the Windows installer.</li>
                <li>Let it register the `farmtracks://` launcher.</li>
                <li>Come back here and launch your route directly from the browser.</li>
              </ol>
            </article>

            <article className="landing-download-card">
              <span className="landing-card-kicker">Choose your route</span>
              <h3>Launch straight into the right overlay</h3>
              <p>
                Your selection is saved locally so the next launch request opens the overlay on the same route.
              </p>
              <div className="landing-map-grid" role="tablist" aria-label="Overlay route selector">
                {MAPS.map((map) => (
                  <button
                    key={map.id}
                    type="button"
                    className={`landing-map-card ${map.id === selectedMapId ? "active" : ""}`}
                    onClick={() => setSelectedMapId(map.id)}
                  >
                    <strong>{map.name}</strong>
                    <span>{map.subtitle}</span>
                  </button>
                ))}
              </div>
              <div className="landing-route-note">
                <strong>{selectedMap.name}</strong>
                <span>{preferredMapDetails?.notes ?? selectedMap.note}</span>
              </div>
            </article>
          </div>

          {overlayGuideContent ? (
            <article className="landing-guide-panel">
              <div>
                <p className="eyebrow">{overlayGuideContent.eyebrow}</p>
                <h3>{overlayGuideContent.title}</h3>
              </div>
              <ol className="landing-step-list">
                {overlayGuideContent.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <button type="button" className="ghost-button landing-guide-dismiss" onClick={() => setOverlayGuideMode("")}>
                Dismiss
              </button>
            </article>
          ) : null}
        </section>

        <section className="landing-section">
          <div className="landing-section-heading">
            <p className="eyebrow">Supported Routes</p>
            <h2>Current farming maps in FarmTracks</h2>
          </div>

          <div className="landing-routes-grid">
            {MAPS.map((map) => {
              const routeDetails = apiState.maps.find((entry) => entry.id === map.id);

              return (
                <article key={map.id} className="landing-route-card">
                  <div className="landing-route-head">
                    <h3>{map.name}</h3>
                    <button type="button" className="ghost-button" onClick={() => setSelectedMapId(map.id)}>
                      Select
                    </button>
                  </div>
                  <p>{routeDetails?.notes ?? map.note}</p>
                  <div className="landing-route-pills">
                    {map.items.map((item) => (
                      <span key={item.id}>{item.name}</span>
                    ))}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
