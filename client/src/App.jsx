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
    return <p className="empty-state">Round gains will chart here once you start capturing inventory snapshots.</p>;
  }

  return (
    <div className="chart-shell">
      <div className="chart-bars" aria-label="Round gain chart">
        {points.map((value, index) => (
          <div key={`${index}-${value}`} className="chart-column">
            <div
              className="chart-bar"
              style={{ height: `${Math.max(14, (value / maxValue) * 100)}%` }}
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
      setFormMessage("One or more item counts went backwards. If you banked items, finish the session first and start a new one.");
      return;
    }

    if (!hasPositiveGain(roundGains)) {
      setFormMessage("Update at least one item count before saving this round.");
      return;
    }

    setPlayers((currentPlayers) =>
      currentPlayers.map((player) =>
        player.id === selectedPlayer.id ? applyRound(player, selectedMap.id, roundSnapshot) : player
      )
    );
    setFormMessage(`Round ${nextRoundNumber} captured from the latest inventory snapshot.`);
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
        <div className="sidebar-brand">
          <div className="brand-badge">FT</div>
          <div>
            <p className="caption">4Vision admin</p>
            <h1>FarmTracks</h1>
          </div>
        </div>

        <form className="sidebar-form" onSubmit={handleAddPlayer}>
          <label htmlFor="playerName">Create player</label>
          <div className="sidebar-form-row">
            <input
              id="playerName"
              value={newPlayerName}
              onChange={(event) => setNewPlayerName(event.target.value)}
              placeholder="Player name"
            />
            <button type="submit" className="primary-button">Add</button>
          </div>
        </form>

        <section className="sidebar-block">
          <div className="section-row">
            <h2>Players</h2>
            <span>{players.length}</span>
          </div>

          {players.length === 0 ? (
            <p className="empty-state">Create a player to begin tracking sessions.</p>
          ) : (
            <div className="player-list">
              {players.map((player) => {
                const liveRounds = Object.values(player.maps).reduce((sum, mapState) => sum + mapState.rounds, 0);

                return (
                  <button
                    key={player.id}
                    type="button"
                    className={`player-tile ${player.id === selectedPlayerId ? "active" : ""}`}
                    onClick={() => setSelectedPlayerId(player.id)}
                  >
                    <strong>{player.name}</strong>
                    <span>{liveRounds} live rounds</span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {storageError ? <p className="warning-text">Browser save issue: {storageError}</p> : null}
      </aside>

      <main className="content-shell">
        <header className="page-header">
          <div>
            <p className="caption">Session operations</p>
            <h2>Inventory checkpoint tracker</h2>
            <p className="subtle-text">
              Players do not need exact per-round drops. After each route, enter current stacks and loose items,
              and FarmTracks calculates the round gain automatically.
            </p>
          </div>

          <div className="map-switcher" role="tablist" aria-label="Map selector">
            {MAPS.map((map) => (
              <button
                key={map.id}
                type="button"
                className={`map-tile ${map.id === selectedMapId ? "active" : ""}`}
                onClick={() => setSelectedMapId(map.id)}
              >
                <strong>{map.name}</strong>
                <span>{map.subtitle}</span>
              </button>
            ))}
          </div>
        </header>

        {!selectedPlayer ? (
          <section className="panel">
            <h3>Select a player</h3>
            <p className="subtle-text">Use the left rail to choose a player before capturing any inventory checkpoints.</p>
          </section>
        ) : (
          <>
            <section className="panel session-panel">
              <div className="session-header">
                <div>
                  <p className="caption">Active session</p>
                  <h3>{selectedPlayer.name} · {selectedMap.name}</h3>
                  <p className="subtle-text">
                    {metadataMap?.notes ?? selectedMap.note}
                  </p>
                </div>

                <div className="session-actions">
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
              </div>

              <div className="stats-grid">
                <article className="stat-card">
                  <span>Next round</span>
                  <strong>{nextRoundNumber}</strong>
                  <small>Checkpoint to capture</small>
                </article>
                <article className="stat-card">
                  <span>Session rounds</span>
                  <strong>{selectedSession?.rounds ?? 0}</strong>
                  <small>Rounds already captured</small>
                </article>
                <article className="stat-card">
                  <span>Session total</span>
                  <strong>{sessionTotal}</strong>
                  <small>Items earned this session</small>
                </article>
                <article className="stat-card">
                  <span>Bag snapshot</span>
                  <strong>{activeSnapshotTotal}</strong>
                  <small>What the player holds now</small>
                </article>
              </div>

              <div className="workspace-grid">
                <form className="panel inner-panel checkpoint-panel" onSubmit={handleCaptureRound}>
                  <div className="section-row">
                    <div>
                      <h3>Checkpoint input</h3>
                      <p className="subtle-text">
                        After each route, enter the current inventory state, not the guessed drop total.
                      </p>
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
                            Current saved: {splitAmount(selectedSession?.currentSnapshot?.[item.id] ?? 0).stacks} stacks ·{" "}
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

                  <div className="capture-preview">
                    <div>
                      <p className="helper-text">
                        {projectedRoundGain > 0
                          ? `This checkpoint will add ${projectedRoundGain} items to round ${nextRoundNumber}.`
                          : "Increase at least one item count to capture a new round."}
                      </p>
                      {formMessage ? <p className="feedback-text">{formMessage}</p> : null}
                    </div>
                    <button type="submit" className="primary-button" disabled={!hasPositiveGain(roundGains)}>
                      Capture round
                    </button>
                  </div>
                </form>

                <div className="analytics-column">
                  <article className="panel inner-panel">
                    <div className="section-row">
                      <h3>Round gain trend</h3>
                      <span>Last 12</span>
                    </div>
                    <RoundTrendChart history={selectedSession?.history ?? []} />
                  </article>

                  <article className="panel inner-panel">
                    <div className="section-row">
                      <h3>Session totals</h3>
                      <span>{selectedMap.items.length} tracked</span>
                    </div>
                    <div className="totals-list">
                      {selectedMap.items.map((item) => {
                        const total = selectedSession?.totals[item.id] ?? 0;
                        const progress = getStackProgress(total);

                        return (
                          <div key={item.id} className="total-row">
                            <div className="total-copy">
                              <strong>{item.name}</strong>
                              <span>{total} earned this session</span>
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
              </div>
            </section>

            <section className="records-grid">
              <article className="panel">
                <div className="section-row">
                  <h3>Recent rounds</h3>
                  <span>Scrollable log</span>
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

              <article className="panel">
                <div className="section-row">
                  <h3>Finished sessions</h3>
                  <span>Archive</span>
                </div>
                {!selectedSession || selectedSession.sessions.length === 0 ? (
                  <p className="empty-state">Finish a session to archive totals here.</p>
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
