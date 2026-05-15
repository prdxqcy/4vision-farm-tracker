import { useEffect, useMemo, useState } from "react";
import { MAPS } from "./mapConfig";
import { loadPlayers, savePlayers } from "./storage";
import {
  applyRound,
  createNewPlayer,
  finishSession,
  getStackProgress,
  getTotalItems,
  hasDrops,
  normalizeRoundInput,
  resetMapProgress
} from "./utils";

const DEFAULT_MAP_ID = MAPS[0].id;

function formatDate(value) {
  return new Date(value).toLocaleString();
}

function App() {
  const [players, setPlayers] = useState(() => loadPlayers());
  const [selectedPlayerId, setSelectedPlayerId] = useState("");
  const [selectedMapId, setSelectedMapId] = useState(DEFAULT_MAP_ID);
  const [newPlayerName, setNewPlayerName] = useState("");
  const [roundValues, setRoundValues] = useState({});
  const [storageError, setStorageError] = useState("");
  const [roundFeedback, setRoundFeedback] = useState("");
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
    const nextValues = selectedMap.items.reduce((accumulator, item) => {
      accumulator[item.id] = "";
      return accumulator;
    }, {});
    setRoundValues(nextValues);
    setRoundFeedback("");
  }, [selectedMapId, selectedPlayerId]);

  const roundDrops = useMemo(
    () => normalizeRoundInput(selectedMap, roundValues),
    [roundValues, selectedMap]
  );

  const hasRoundInput = hasDrops(roundDrops);
  const nextRoundNumber = (selectedSession?.rounds ?? 0) + 1;
  const totalItemsInSession = getTotalItems(selectedSession?.totals ?? {});

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

  function handleRoundValueChange(itemId, nextValue) {
    setRoundValues((currentValues) => ({
      ...currentValues,
      [itemId]: nextValue
    }));
    setRoundFeedback("");
  }

  function clearRoundInputs() {
    setRoundValues(
      selectedMap.items.reduce((accumulator, item) => {
        accumulator[item.id] = "";
        return accumulator;
      }, {})
    );
  }

  function handleSaveRound(event) {
    event.preventDefault();

    if (!selectedPlayer) {
      return;
    }

    if (!hasRoundInput) {
      setRoundFeedback("Enter at least one drop before saving the round.");
      return;
    }

    setPlayers((currentPlayers) =>
      currentPlayers.map((player) =>
        player.id === selectedPlayer.id ? applyRound(player, selectedMap.id, roundDrops) : player
      )
    );
    clearRoundInputs();
    setRoundFeedback(`Round ${nextRoundNumber} saved to the active session.`);
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
    clearRoundInputs();
    setRoundFeedback(`Session finished for ${selectedPlayer.name} on ${selectedMap.name}.`);
  }

  function handleClearSession() {
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
    clearRoundInputs();
    setRoundFeedback(`Current session cleared for ${selectedPlayer.name}.`);
  }

  function handleDeletePlayer(playerId) {
    setPlayers((currentPlayers) => currentPlayers.filter((player) => player.id !== playerId));
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark">FT</div>
          <div>
            <p className="caption">4Vision tracker</p>
            <h1>FarmTracks</h1>
          </div>
        </div>

        <form className="player-creator" onSubmit={handleAddPlayer}>
          <label htmlFor="playerName">Add player</label>
          <div className="input-row">
            <input
              id="playerName"
              value={newPlayerName}
              onChange={(event) => setNewPlayerName(event.target.value)}
              placeholder="Player name"
            />
            <button type="submit" className="primary-button">Create</button>
          </div>
        </form>

        <section className="sidebar-section">
          <div className="section-title-row">
            <h2>Players</h2>
            <span>{players.length}</span>
          </div>

          {players.length === 0 ? (
            <p className="empty-state">Create a player to start a farming session.</p>
          ) : (
            <div className="player-list">
              {players.map((player) => {
                const totalRounds = Object.values(player.maps).reduce(
                  (sum, mapState) => sum + mapState.rounds,
                  0
                );

                return (
                  <button
                    key={player.id}
                    type="button"
                    className={`player-nav-item ${player.id === selectedPlayerId ? "active" : ""}`}
                    onClick={() => setSelectedPlayerId(player.id)}
                  >
                    <strong>{player.name}</strong>
                    <span>{totalRounds} active rounds</span>
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
            <p className="caption">Session tracking</p>
            <h2>Round logging workspace</h2>
            <p className="subtle-text">
              Enter what dropped each round. FarmTracks keeps a running session total until you finish.
            </p>
          </div>

          <div className="map-switcher" role="tablist" aria-label="Map selector">
            {MAPS.map((map) => (
              <button
                key={map.id}
                type="button"
                className={`map-chip ${map.id === selectedMapId ? "active" : ""}`}
                onClick={() => setSelectedMapId(map.id)}
              >
                <span>{map.name}</span>
                <small>{map.items.length} drops</small>
              </button>
            ))}
          </div>
        </header>

        {!selectedPlayer ? (
          <section className="panel empty-panel">
            <h3>No player selected</h3>
            <p className="subtle-text">Choose a player from the sidebar or create one to begin tracking rounds.</p>
          </section>
        ) : (
          <>
            <section className="panel session-panel">
              <div className="session-panel-head">
                <div>
                  <p className="caption">Active session</p>
                  <h3>{selectedPlayer.name} on {selectedMap.name}</h3>
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
                  <button type="button" className="ghost-button" onClick={handleClearSession}>
                    Clear current
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
                  <span>Current round</span>
                  <strong>{nextRoundNumber}</strong>
                  <small>Next round to save</small>
                </article>
                <article className="stat-card">
                  <span>Session rounds</span>
                  <strong>{selectedSession?.rounds ?? 0}</strong>
                  <small>Saved this session</small>
                </article>
                <article className="stat-card">
                  <span>Session items</span>
                  <strong>{totalItemsInSession}</strong>
                  <small>All drops combined</small>
                </article>
                <article className="stat-card">
                  <span>Completed sessions</span>
                  <strong>{selectedSession?.sessions.length ?? 0}</strong>
                  <small>Archived for this map</small>
                </article>
              </div>

              <div className="session-workspace">
                <form className="round-entry-card" onSubmit={handleSaveRound}>
                  <div className="section-title-row">
                    <div>
                      <h3>Round {nextRoundNumber} input</h3>
                      <p className="subtle-text">Enter only what dropped on this route loop.</p>
                    </div>
                    <span className={`status-pill ${apiState.error ? "offline" : "ready"}`}>
                      {apiState.loading ? "API loading" : apiState.error ? "API offline" : "API ready"}
                    </span>
                  </div>

                  <div className="round-input-grid">
                    {selectedMap.items.map((item) => (
                      <label key={item.id} className="drop-input-card">
                        <span className="drop-label">{item.name}</span>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={roundValues[item.id] ?? ""}
                          onChange={(event) => handleRoundValueChange(item.id, event.target.value)}
                          placeholder="0"
                        />
                      </label>
                    ))}
                  </div>

                  <div className="form-footer">
                    <div>
                      <p className="helper-text">
                        {hasRoundInput
                          ? `Round ${nextRoundNumber} will be added to the current session.`
                          : "Enter at least one item amount to save the round."}
                      </p>
                      {roundFeedback ? <p className="feedback-text">{roundFeedback}</p> : null}
                    </div>
                    <button type="submit" className="primary-button" disabled={!hasRoundInput}>
                      Save round
                    </button>
                  </div>
                </form>

                <article className="session-summary-card">
                  <div className="section-title-row">
                    <h3>Session totals</h3>
                    <span>{selectedMap.items.length} items</span>
                  </div>
                  <p className="subtle-text">
                    Started {selectedSession ? formatDate(selectedSession.startedAt) : "just now"}
                  </p>

                  <div className="totals-list">
                    {selectedMap.items.map((item) => {
                      const total = selectedSession?.totals[item.id] ?? 0;
                      const progress = getStackProgress(total);

                      return (
                        <div key={item.id} className="total-row">
                          <div className="total-copy">
                            <strong>{item.name}</strong>
                            <span>{total} total</span>
                          </div>
                          <div className="total-progress">
                            <div className="progress-track">
                              <div
                                className="progress-fill"
                                style={{ width: `${progress.percent}%`, backgroundColor: item.color }}
                              />
                            </div>
                            <span>{progress.fullStacks} stacks, {progress.remainder}/200</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </article>
              </div>
            </section>

            <section className="bottom-grid">
              <article className="panel">
                <div className="section-title-row">
                  <h3>Recent rounds</h3>
                  <span>Latest 12</span>
                </div>

                {!selectedSession || selectedSession.history.length === 0 ? (
                  <p className="empty-state">Saved rounds will appear here during the active session.</p>
                ) : (
                  <div className="records-table">
                    {selectedSession.history.map((entry) => (
                      <div key={entry.id} className="record-row">
                        <div className="record-meta">
                          <strong>Round {entry.round}</strong>
                          <span>{formatDate(entry.createdAt)}</span>
                        </div>
                        <div className="record-values">
                          {selectedMap.items.map((item) => (
                            <span key={item.id}>
                              {item.name}: {entry.drops[item.id] ?? 0}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </article>

              <article className="panel">
                <div className="section-title-row">
                  <h3>Finished sessions</h3>
                  <span>Latest 8</span>
                </div>

                {!selectedSession || selectedSession.sessions.length === 0 ? (
                  <p className="empty-state">Finish a session to archive its totals here.</p>
                ) : (
                  <div className="records-table">
                    {selectedSession.sessions.map((session) => (
                      <div key={session.id} className="record-row">
                        <div className="record-meta">
                          <strong>{session.rounds} rounds</strong>
                          <span>{formatDate(session.finishedAt)}</span>
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
