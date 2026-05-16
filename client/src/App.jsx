import { useEffect, useMemo, useState } from "react";
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

function formatDate(value) {
  return new Date(value).toLocaleString();
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

function OverlayAccessPanel({ guideMode, installerUrl, isDesktopShell, mapName, onDismiss, onInstall, onLaunch }) {
  const guideCopy = {
    install: {
      eyebrow: "Install Started",
      title: "Set up the Windows overlay app",
      steps: [
        "Your browser should start downloading the FarmTracks Overlay installer.",
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
        "If nothing opens, install the overlay app first and then press Launch Overlay again.",
        "Run your game in borderless windowed mode for the always-on-top overlay to stay visible."
      ]
    },
    desktop: {
      eyebrow: "Desktop Mode",
      title: "Open the native overlay window",
      steps: [
        `Press Open Overlay to launch the always-on-top panel for ${mapName}.`,
        "Drag the overlay by its header and keep it near your game HUD.",
        "Use borderless windowed mode in-game for the most reliable overlay behavior.",
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
  const [apiState, setApiState] = useState({
    loading: true,
    error: "",
    maps: []
  });

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
    window.location.href = getProtocolLaunchUrl(selectedMapId);
  }

  function handleCloseOverlay() {
    if (isDesktopShell) {
      window.farmtracksDesktop.closeCurrentWindow();
      return;
    }

    window.close();
  }

  function handleCaptureRound(event) {
    event.preventDefault();

    if (!selectedPlayer || !selectedSession) {
      return;
    }

    if (hasNegativeGain(roundGains)) {
      setFormMessage("One or more counts moved backward. Finish this session before banking or dropping items.");
      return;
    }

    if (!hasPositiveGain(roundGains)) {
      setFormMessage("Update at least one inventory count before capturing the round.");
      return;
    }

    setPlayers((currentPlayers) =>
      currentPlayers.map((player) =>
        player.id === selectedPlayer.id ? applyRound(player, selectedMap.id, roundSnapshot) : player
      )
    );
    setFormMessage(`Round ${nextRoundNumber} captured from the latest inventory checkpoint.`);
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

  if (isOverlayMode) {
    return (
      <main className="overlay-shell">
        <section className="overlay-header page-panel">
          <div>
            <p className="eyebrow">FarmTracks Overlay</p>
            <h1>{selectedMap.name} Capture</h1>
          </div>
          <div className="overlay-header-meta">
            <button type="button" className="ghost-button overlay-close-button" onClick={handleCloseOverlay}>
              Close
            </button>
          </div>
        </section>

        {selectedPlayer ? (
          <>
            <section className="overlay-map-switcher page-panel">
              <div className="panel-header">
                <div>
                  <h2>Route</h2>
                  <p className="subtle-text">Switch the active farming route without touching the main window.</p>
                </div>
              </div>
              <div className="sidebar-map-list overlay-map-list" role="tablist" aria-label="Map selector">
                {MAPS.map((map) => (
                  <button
                    key={map.id}
                    type="button"
                    className={`sidebar-map-item ${map.id === selectedMapId ? "active" : ""}`}
                    onClick={() => setSelectedMapId(map.id)}
                  >
                    <strong>{map.name}</strong>
                    <span>{map.subtitle}</span>
                  </button>
                ))}
              </div>
            </section>

            <CapturePanel
              formMessage={formMessage}
              handleCaptureRound={handleCaptureRound}
              handleInventoryChange={handleInventoryChange}
              inventoryInputs={inventoryInputs}
              isDesktopShell={isDesktopShell}
              isOverlayMode
              onOpenOverlay={handleOpenOverlay}
              projectedRoundGain={projectedRoundGain}
              roundGains={roundGains}
              selectedMap={selectedMap}
              selectedSession={selectedSession}
              nextRoundNumber={nextRoundNumber}
            />
          </>
        ) : (
          <section className="page-panel onboarding-panel">
            <div className="title-plate compact">
              <p className="eyebrow">Ready Room</p>
              <h2>Preparing Local Session</h2>
              <div className="title-divider" />
            </div>
            <p className="subtle-text">FarmTracks is preparing the overlay session.</p>
          </section>
        )}
      </main>
    );
  }

  return (
    <div className="site-shell">
      <div className="shell-layout">
        <aside className="site-sidebar">
          <div className="sidebar-frame">
          <a className="brand-link" href="https://vision4s.com/" target="_blank" rel="noreferrer">
            <img src="/vision4-assets/vision4-logo.png" alt="4Vision" className="brand-logo" />
          </a>

            <div className="site-status-bar">
              <span className={`live-indicator ${apiState.error ? "offline" : ""}`}>
                {apiState.loading ? "Syncing" : apiState.error ? "Offline" : "Online"}
              </span>
            </div>

            <nav className="site-nav sidebar-nav" aria-label="FarmTracks sections">
              <button type="button" className="site-nav-item active">Operations</button>
            </nav>

            <section className="sidebar-panel session-identity">
              <span className="sidebar-kicker">Local session</span>
              <strong>{selectedMap.name}</strong>
              <small>{selectedPlayer ? `${selectedSession?.rounds ?? 0} live rounds on this route` : "Preparing local session"}</small>
            </section>

            <section className="sidebar-panel">
              <div className="sidebar-section-head">
                <h2>Map Focus</h2>
                <p className="subtle-text">Swap routes from the control rail.</p>
              </div>

              <div className="sidebar-map-list" role="tablist" aria-label="Map selector">
                {MAPS.map((map) => (
                  <button
                    key={map.id}
                    type="button"
                    className={`sidebar-map-item ${map.id === selectedMapId ? "active" : ""}`}
                    onClick={() => setSelectedMapId(map.id)}
                  >
                    <strong>{map.name}</strong>
                    <span>{map.subtitle}</span>
                  </button>
                ))}
              </div>
            </section>

            <section className="sidebar-panel sidebar-meta">
              <div className="meta-entry">
                <span>Persistence</span>
                <strong>{storageError ? storageError : "Browser persistence is active for this device."}</strong>
              </div>
              <div className="meta-entry">
                <span>Session start</span>
                <strong>{selectedSession?.startedAt ? formatDate(selectedSession.startedAt) : "No active session"}</strong>
              </div>
            </section>
          </div>
        </aside>

        <main className="site-main">
          <section className="title-panel">
            <div className="title-plate">
              <p className="eyebrow">4Vision Farm Operations</p>
              <h1>Inventory Command Board</h1>
              <div className="title-divider" />
            </div>
          </section>

          {!selectedPlayer ? (
            <section className="page-panel onboarding-panel">
              <div className="title-plate compact">
                <p className="eyebrow">Ready Room</p>
                <h2>Preparing Local Session</h2>
                <div className="title-divider" />
              </div>
              <p className="subtle-text">
                FarmTracks is setting up the local browser session for {selectedMap.name}. The live checkpoint board
                will appear automatically.
              </p>
            </section>
          ) : (
            <>
              <section className="page-panel session-panel">
                <div className="session-hero">
                  <div>
                    <p className="eyebrow">Live Session</p>
                    <h2>{selectedMap.name} farming route</h2>
                    <p className="subtle-text">{metadataMap?.notes ?? selectedMap.note}</p>
                  </div>

                  <div className="hero-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={handleFinishSession}
                      disabled={!selectedSession || selectedSession.rounds === 0}
                    >
                      Finish session
                    </button>
                    <button type="button" className="ghost-button" onClick={handleResetSession}>
                      Reset session
                    </button>
                  </div>
                </div>

                <div className="session-stats">
                  <article className="stat-cell">
                    <span>Next round</span>
                    <strong>{nextRoundNumber}</strong>
                    <small>Checkpoint ready</small>
                  </article>
                  <article className="stat-cell">
                    <span>Session rounds</span>
                    <strong>{selectedSession?.rounds ?? 0}</strong>
                    <small>Saved on this route</small>
                  </article>
                  <article className="stat-cell">
                    <span>Session yield</span>
                    <strong>{sessionTotal}</strong>
                    <small>Total items earned</small>
                  </article>
                  <article className="stat-cell">
                    <span>Current bag</span>
                    <strong>{mapSnapshot.stacks}</strong>
                    <small>{mapSnapshot.loose} loose items</small>
                  </article>
                  <article className="stat-cell">
                    <span>Archived runs</span>
                    <strong>{completedSessions}</strong>
                    <small>Completed sessions</small>
                  </article>
                  <article className="stat-cell">
                    <span>Player load</span>
                    <strong>{allLiveRounds}</strong>
                    <small>Rounds across all maps</small>
                  </article>
                </div>
              </section>

              <OverlayAccessPanel
                guideMode={overlayGuideMode}
                installerUrl={OVERLAY_INSTALLER_URL}
                isDesktopShell={isDesktopShell}
                mapName={selectedMap.name}
                onDismiss={() => setOverlayGuideMode("")}
                onInstall={handleInstallOverlay}
                onLaunch={handleLaunchOverlayApp}
              />

              <section className="content-grid">
                <CapturePanel
                  formMessage={formMessage}
                  handleCaptureRound={handleCaptureRound}
                  handleInventoryChange={handleInventoryChange}
                  inventoryInputs={inventoryInputs}
                  isDesktopShell={isDesktopShell}
                  isOverlayMode={false}
                  onOpenOverlay={handleOpenOverlay}
                  projectedRoundGain={projectedRoundGain}
                  roundGains={roundGains}
                  selectedMap={selectedMap}
                  selectedSession={selectedSession}
                  nextRoundNumber={nextRoundNumber}
                />

                <div className="stack-column">
                  <article className="page-panel insight-panel">
                    <div className="panel-header">
                      <div>
                        <h2>Round Gain Trend</h2>
                        <p className="subtle-text">Last 12 captured rounds.</p>
                      </div>
                    </div>
                    <RoundTrendChart history={selectedSession?.history ?? []} />
                  </article>

                  <article className="page-panel insight-panel">
                    <div className="panel-header">
                      <div>
                        <h2>Session Inventory</h2>
                        <p className="subtle-text">{selectedMap.items.length} tracked items on this route.</p>
                      </div>
                    </div>

                    <div className="totals-list">
                      {selectedMap.items.map((item) => {
                        const total = selectedSession?.totals[item.id] ?? 0;
                        const progress = getStackProgress(total);

                        return (
                          <div key={item.id} className="total-row">
                            <div className="total-copy">
                              <strong>{item.name}</strong>
                              <span>{total} items earned this session</span>
                            </div>
                            <div className="total-metric">
                              <span>{progress.fullStacks} stacks</span>
                              <small>{progress.remainder} / {STACK_SIZE}</small>
                            </div>
                            <div className="progress-track">
                              <div
                                className="progress-fill"
                                style={{ width: `${progress.percent}%`, backgroundColor: item.color }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </article>
                </div>
              </section>

              <section className="records-grid">
                <article className="page-panel records-card">
                  <div className="panel-header">
                    <div>
                      <h2>Recent Rounds</h2>
                      <p className="subtle-text">Latest checkpoints on {selectedMap.name}.</p>
                    </div>
                  </div>

                  {!selectedSession || selectedSession.history.length === 0 ? (
                    <p className="empty-state">Captured rounds will appear here.</p>
                  ) : (
                    <div className="scroll-region">
                      <div className="records-list">
                        {selectedSession.history.map((entry) => (
                          <div key={entry.id} className="record-card">
                            <div className="record-head">
                              <div>
                                <strong>Round {entry.round}</strong>
                                <span>{formatDate(entry.createdAt)}</span>
                              </div>
                              <b>+{getTotalItems(entry.gains)}</b>
                            </div>
                            <div className="record-values">
                              {selectedMap.items.map((item) => (
                                <span key={item.id}>
                                  {item.name}: +{entry.gains[item.id] ?? 0}
                                </span>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </article>

                <article className="page-panel records-card">
                  <div className="panel-header">
                    <div>
                      <h2>Finished Sessions</h2>
                      <p className="subtle-text">Completed run archive for this map.</p>
                    </div>
                  </div>

                  {!selectedSession || selectedSession.sessions.length === 0 ? (
                    <p className="empty-state">Finish a session to archive its totals here.</p>
                  ) : (
                    <div className="records-list">
                      {selectedSession.sessions.map((session) => (
                        <div key={session.id} className="record-card">
                          <div className="record-head">
                            <div>
                              <strong>{session.rounds} rounds</strong>
                              <span>{formatDate(session.finishedAt)}</span>
                            </div>
                            <b>{getTotalItems(session.totals)} total</b>
                          </div>
                          <div className="record-values">
                            {selectedMap.items.map((item) => (
                              <span key={item.id}>
                                {item.name}: {session.totals[item.id] ?? 0}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              </section>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
