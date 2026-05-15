import { useEffect, useMemo, useState } from "react";
import { MAPS, STACK_SIZE } from "./mapConfig";
import { loadPlayers, savePlayers } from "./storage";
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
  const [players, setPlayers] = useState(() => loadPlayers());
  const [selectedPlayerId, setSelectedPlayerId] = useState("");
  const [selectedMapId, setSelectedMapId] = useState(DEFAULT_MAP_ID);
  const [newPlayerName, setNewPlayerName] = useState("");
  const [inventoryInputs, setInventoryInputs] = useState({});
  const [storageError, setStorageError] = useState("");
  const [formMessage, setFormMessage] = useState("");
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

  function handleAddPlayer(event) {
    event.preventDefault();

    if (!newPlayerName.trim()) {
      return;
    }

    const player = createNewPlayer(newPlayerName);
    setPlayers((currentPlayers) => [player, ...currentPlayers]);
    setSelectedPlayerId(player.id);
    setNewPlayerName("");
  }

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

  function handleDeletePlayer(playerId) {
    setPlayers((currentPlayers) => currentPlayers.filter((player) => player.id !== playerId));
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand-block">
            <div className="brand-mark">FT</div>
            <div>
              <p className="eyebrow">4Vision Operations</p>
              <h1>FarmTracks</h1>
            </div>
          </div>

          <div className="sidebar-overview card-like">
            <div className="sidebar-overview-row">
              <span>Players</span>
              <strong>{players.length}</strong>
            </div>
            <div className="sidebar-overview-row">
              <span>Maps</span>
              <strong>{MAPS.length}</strong>
            </div>
            <div className="sidebar-overview-row">
              <span>API</span>
              <strong>{apiState.loading ? "..." : apiState.error ? "Offline" : "Ready"}</strong>
            </div>
          </div>
        </div>

        <section className="sidebar-section">
          <div className="sidebar-section-header">
            <span className="sidebar-label">Map focus</span>
          </div>
          <div className="sidebar-map-list">
            {MAPS.map((map) => (
              <button
                key={map.id}
                type="button"
                className={`sidebar-map-item ${map.id === selectedMapId ? "active" : ""}`}
                onClick={() => setSelectedMapId(map.id)}
              >
                <strong>{map.name}</strong>
                <span>{map.items.length} tracked drops</span>
              </button>
            ))}
          </div>
        </section>

        <section className="sidebar-section">
          <div className="sidebar-section-header">
            <span className="sidebar-label">Player roster</span>
          </div>

          <form className="sidebar-form" onSubmit={handleAddPlayer}>
            <input
              id="playerName"
              value={newPlayerName}
              onChange={(event) => setNewPlayerName(event.target.value)}
              placeholder="Create player"
            />
            <button type="submit" className="primary-button small-button">Add player</button>
          </form>

          {players.length === 0 ? (
            <p className="empty-state">Create a player to start tracking sessions.</p>
          ) : (
            <div className="player-list">
              {players.map((player) => {
                const liveRounds = Object.values(player.maps).reduce((sum, mapState) => sum + mapState.rounds, 0);
                const currentMapRounds = player.maps[selectedMap.id]?.rounds ?? 0;

                return (
                  <button
                    key={player.id}
                    type="button"
                    className={`player-tile ${player.id === selectedPlayerId ? "active" : ""}`}
                    onClick={() => setSelectedPlayerId(player.id)}
                  >
                    <div className="player-tile-head">
                      <strong>{player.name}</strong>
                      <span>{currentMapRounds} on this map</span>
                    </div>
                    <small>{liveRounds} live rounds across all maps</small>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <div className="sidebar-footer card-like">
          <span className="sidebar-label">Storage</span>
          <p>{storageError ? storageError : "Browser persistence is active for this device."}</p>
        </div>
      </aside>

      <main className="content-shell">
        <header className="page-header">
          <div className="page-header-copy">
            <p className="eyebrow">Dashboard</p>
            <h2>{selectedMap.name} farming operations</h2>
            <p className="subtle-text max-copy">
              Enter current stack counts after each route. FarmTracks turns those checkpoints into round gains,
              keeps the running session total, and preserves the history for review.
            </p>
          </div>

          <div className="page-header-meta">
            <div className="meta-chip">
              <span>Selected player</span>
              <strong>{selectedPlayer?.name ?? "None"}</strong>
            </div>
            <div className="meta-chip">
              <span>Map mode</span>
              <strong>Looped route</strong>
            </div>
          </div>
        </header>

        {!selectedPlayer ? (
          <section className="hero-card">
            <div className="hero-card-copy">
              <h3>Select a player to start</h3>
              <p className="subtle-text">
                Choose a player from the sidebar or create a new one. The tracker will then open the live
                checkpoint workspace for {selectedMap.name}.
              </p>
            </div>
          </section>
        ) : (
          <>
            <section className="hero-card">
              <div className="hero-card-copy">
                <p className="eyebrow">Live session</p>
                <h3>{selectedPlayer.name} - {selectedMap.name}</h3>
                <p className="subtle-text max-copy">
                  {metadataMap?.notes ?? selectedMap.note}
                </p>
              </div>

              <div className="hero-card-actions">
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
                <button
                  type="button"
                  className="ghost-button danger-button"
                  onClick={() => handleDeletePlayer(selectedPlayer.id)}
                >
                  Delete player
                </button>
              </div>
            </section>

            <section className="kpi-grid">
              <article className="kpi-card">
                <span>Next round</span>
                <strong>{nextRoundNumber}</strong>
                <small>Checkpoint ready to capture</small>
              </article>
              <article className="kpi-card">
                <span>Session rounds</span>
                <strong>{selectedSession?.rounds ?? 0}</strong>
                <small>Rounds saved on this map</small>
              </article>
              <article className="kpi-card">
                <span>Session yield</span>
                <strong>{sessionTotal}</strong>
                <small>Total items earned this session</small>
              </article>
              <article className="kpi-card">
                <span>Current bag</span>
                <strong>{mapSnapshot.stacks}</strong>
                <small>Stacks and {mapSnapshot.loose} loose items</small>
              </article>
              <article className="kpi-card">
                <span>Archived sessions</span>
                <strong>{completedSessions}</strong>
                <small>Completed runs for this map</small>
              </article>
              <article className="kpi-card">
                <span>Player load</span>
                <strong>{allLiveRounds}</strong>
                <small>Active rounds across all maps</small>
              </article>
            </section>

            <section className="dashboard-grid">
              <form className="dashboard-card capture-card" onSubmit={handleCaptureRound}>
                <div className="card-header">
                  <div>
                    <p className="card-label">Checkpoint input</p>
                    <h3>Capture current inventory</h3>
                  </div>
                  <span className={`status-pill ${apiState.error ? "offline" : ""}`}>
                    {apiState.loading ? "API loading" : apiState.error ? "API offline" : "API ready"}
                  </span>
                </div>

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
                          <span>Loose</span>
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

              <div className="insights-column">
                <article className="dashboard-card chart-card">
                  <div className="card-header">
                    <div>
                      <p className="card-label">Performance</p>
                      <h3>Round gain trend</h3>
                    </div>
                    <span className="card-meta">Last 12 rounds</span>
                  </div>
                  <RoundTrendChart history={selectedSession?.history ?? []} />
                </article>

                <article className="dashboard-card totals-card">
                  <div className="card-header">
                    <div>
                      <p className="card-label">Totals</p>
                      <h3>Session inventory</h3>
                    </div>
                    <span className="card-meta">{selectedMap.items.length} items tracked</span>
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
              <article className="dashboard-card records-card">
                <div className="card-header">
                  <div>
                    <p className="card-label">History</p>
                    <h3>Recent rounds</h3>
                  </div>
                  <span className="card-meta">Scrollable log</span>
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

              <article className="dashboard-card records-card">
                <div className="card-header">
                  <div>
                    <p className="card-label">Archive</p>
                    <h3>Finished sessions</h3>
                  </div>
                  <span className="card-meta">Latest completed runs</span>
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
  );
}

export default App;
