import { useEffect, useMemo, useRef, useState } from "react";
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
const DEFAULT_OVERLAY_INSTALLER_URL = "https://github.com/prdxqcy/OCR-Scanner/releases";
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
  inventoryInputs,
  onInventoryChange,
  onCaptureRound,
  roundGains,
  hotkeys,
  onSaveHotkeys,
  trackerRegions,
  onSetTrackerRegion,
  onClearTrackerRegion,
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

        <div className="overlay-bag-area-row" style={{ flexDirection: "column", gap: 4 }}>
          {[
            { key: "crystals", label: "Crystals" },
            { key: "arcanes", label: "Arcanes" },
            { key: "speed-potions", label: "Potions" },
          ].map(({ key, label }) => {
            const hasRegion = Boolean(trackerRegions?.[key]?.region);
            return (
              <div key={key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ flex: 1, fontSize: "0.78em", opacity: 0.75 }}>{label}</span>
                {hasRegion ? (
                  <>
                    <span className="overlay-bag-area-set" style={{ fontSize: "0.75em" }}>✓</span>
                    <button type="button" className="overlay-zero-btn" onClick={() => onSetTrackerRegion(key)}>Change</button>
                    <button type="button" className="overlay-zero-btn" onClick={() => onClearTrackerRegion(key)}>Clear</button>
                  </>
                ) : (
                  <button type="button" className="overlay-bag-area-btn" style={{ flex: 2 }} onClick={() => onSetTrackerRegion(key)}>
                    Set region
                  </button>
                )}
              </div>
            );
          })}
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
  const [trackerRegions, setTrackerRegions] = useState({});

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

    window.farmtracksDesktop.getTrackerRegions?.().then((r) => setTrackerRegions(r ?? {})).catch(() => {});
    const unsubRegion = window.farmtracksDesktop.onTrackerRegionsUpdated?.((r) => setTrackerRegions(r ?? {})) ?? (() => {});

    return () => {
      unsubUpdate();
      unsubHotkey();
      unsubHotkeys();
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

  function handleSetTrackerRegion(trackerKey) {
    if (!isDesktopShell) return;
    window.farmtracksDesktop.openTrackerRegionSelector(trackerKey);
  }

  function handleClearTrackerRegion(trackerKey) {
    if (!isDesktopShell) return;
    window.farmtracksDesktop.clearTrackerRegion(trackerKey);
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
            inventoryInputs={inventoryInputs}
            onInventoryChange={handleInventoryChange}
            onCaptureRound={() => applySnapshot(normalizeRoundInput(selectedMap, inventoryInputs), "manual input")}
            roundGains={roundGains}
            hotkeys={hotkeys}
            onSaveHotkeys={handleSaveHotkeys}
            trackerRegions={trackerRegions}
            onSetTrackerRegion={handleSetTrackerRegion}
            onClearTrackerRegion={handleClearTrackerRegion}
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
    <div className="site-shell">
      <nav className="site-nav">
        <a className="site-nav-brand" href="https://vision4s.com/" target="_blank" rel="noreferrer">
          <img src="/vision4-assets/vision4-logo.png" alt="4Vision" />
        </a>
        <div className="site-nav-links">
          <a href="#features">Features</a>
          <a href="#how-it-works">How It Works</a>
          <a href="#download">Download</a>
          <a href="https://vision4s.com/" target="_blank" rel="noreferrer">4Vision</a>
        </div>
      </nav>

      <section className="site-hero">
        <div className="site-hero-inner">
          <p className="site-hero-eyebrow">4Vision Farming Tool</p>
          <h1 className="site-hero-title">FarmTracks Overlay</h1>
          <div className="site-dev-notice" role="note" aria-label="Development status notice">
            THIS PROJECT IS STILL UNDERGOING DEVELOPMENT, PLEASE BE PATIENT. AUTO SCANNING IS STILL IN DEVELOPMENT.
            MANUAL INPUT WORKS AS INTENDED.
          </div>
          <p className="site-hero-sub">
            Real-time item scanner for Narwashi runs. An always-on-top overlay that counts crystals,
            arcanes and speed potions automatically — so you can focus on farming.
          </p>
          <a
            className="site-hero-btn"
            href={OVERLAY_INSTALLER_URL}
            target="_blank"
            rel="noreferrer"
            onClick={handleInstallOverlay}
          >
            Download for Windows
          </a>
        </div>
      </section>

      <section id="features" style={{ maxWidth: 1100, margin: "0 auto", width: "100%", padding: "72px 24px 0" }}>
        <div className="site-section-head">
          <h2>What it does</h2>
          <div className="site-rule" />
        </div>
      </section>

      <div style={{ maxWidth: 1100, margin: "0 auto", width: "100%", padding: "0 24px 72px" }}>
        <div className="site-feature">
          <div className="site-feature-text">
            <h3>Auto-Scanner</h3>
            <p>
              Scans your bag every second and counts crystals, arcanes and speed potions automatically.
              No clicking, no manual input — just keep farming and the overlay keeps up.
            </p>
          </div>
          <div className="site-feature-visual">
            <img src="/vision4-assets/feature-auto-scanner.svg" alt="Auto-scanner overlay illustration" />
          </div>
        </div>

        <div className="site-feature site-feature-flip">
          <div className="site-feature-text">
            <h3>Bag Area Selector</h3>
            <p>
              Draw a box over your inventory once. From then on the scanner only looks inside that region —
              no false reads from the rest of the screen.
            </p>
          </div>
          <div className="site-feature-visual">
            <img src="/vision4-assets/feature-bag-area.svg" alt="Bag area selection illustration" />
          </div>
        </div>

        <div className="site-feature">
          <div className="site-feature-text">
            <h3>Hotkeys</h3>
            <p>
              F7 shows or hides the overlay. F8 resets the item baseline. F9 records a round.
              All three are rebindable from inside the overlay.
            </p>
          </div>
          <div className="site-feature-visual">
            <img src="/vision4-assets/feature-hotkeys.svg" alt="Hotkey controls illustration" />
          </div>
        </div>

        <div className="site-feature site-feature-flip">
          <div className="site-feature-text">
            <h3>Round Tracking</h3>
            <p>
              Every time your count increases, FarmTracks logs the gain. See what you collected each run
              and across your whole farming session without leaving the game.
            </p>
          </div>
          <div className="site-feature-visual">
            <img src="/vision4-assets/feature-round-tracking.svg" alt="Round tracking chart illustration" />
          </div>
        </div>
      </div>

      <section id="how-it-works" className="site-section">
        <div className="site-section-head">
          <h2>How to use it</h2>
          <div className="site-rule" />
        </div>
        <ol className="site-steps">
          <li>
            <span className="site-step-num">01</span>
            <div>
              <h3>Download and install</h3>
              <p>Run the Windows installer. It sets up the overlay and registers the farmtracks:// link so you can relaunch it from any browser.</p>
            </div>
          </li>
          <li>
            <span className="site-step-num">02</span>
            <div>
              <h3>Open the overlay</h3>
              <p>Launch FarmTracks from your desktop shortcut or press the button on this page. Drag it next to your game HUD.</p>
            </div>
          </li>
          <li>
            <span className="site-step-num">03</span>
            <div>
              <h3>Set your bag area</h3>
              <p>Click "Set bag area" in the overlay and drag a box around your inventory. The scanner only looks there from now on.</p>
            </div>
          </li>
          <li>
            <span className="site-step-num">04</span>
            <div>
              <h3>Start the scanner and farm</h3>
              <p>Press Start. The overlay reads your bag every second. Hit F9 to save a round whenever you finish a run.</p>
            </div>
          </li>
        </ol>
      </section>

      <section id="download" className="site-section site-download">
        <div className="site-section-head">
          <h2>Get FarmTracks</h2>
          <div className="site-rule" />
        </div>
        <p className="site-download-sub">Free Windows overlay. No account needed.</p>
        <div className="site-download-actions">
          <a
            className="site-hero-btn"
            href={OVERLAY_INSTALLER_URL}
            target="_blank"
            rel="noreferrer"
            onClick={handleInstallOverlay}
          >
            Download Installer
          </a>
          <button type="button" className="site-launch-btn" onClick={handleLaunchOverlayApp}>
            Launch Overlay
          </button>
        </div>
        {overlayGuideContent ? (
          <div className="site-guide">
            <p className="site-guide-eyebrow">{overlayGuideContent.eyebrow}</p>
            <h3>{overlayGuideContent.title}</h3>
            <ol>
              {overlayGuideContent.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <button type="button" className="site-guide-dismiss" onClick={() => setOverlayGuideMode("")}>Dismiss</button>
          </div>
        ) : null}
      </section>

      <footer className="site-footer">
        <img src="/vision4-assets/vision4-logo.png" alt="4Vision" className="site-footer-logo" />
        <div className="site-footer-links">
          <a href="https://vision4s.com/" target="_blank" rel="noreferrer">4Vision</a>
          <a href={OVERLAY_INSTALLER_URL} target="_blank" rel="noreferrer">Download</a>
          <a href="https://github.com/prdxqcy/4vision-farm-tracker" target="_blank" rel="noreferrer">GitHub</a>
        </div>
        <p className="site-footer-copy">FarmTracks Overlay — 4Vision Farming Tool</p>
      </footer>
    </div>
  );
}

export default App;
