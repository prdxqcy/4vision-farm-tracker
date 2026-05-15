import { useEffect, useMemo, useState } from "react";
import { MAPS } from "./mapConfig";
import { loadPlayers, savePlayers } from "./storage";
import {
  applyRound,
  createNewPlayer,
  getStackProgress,
  hasDrops,
  normalizeRoundInput,
  resetMapProgress
} from "./utils";

const DEFAULT_MAP_ID = MAPS[0].id;

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
  }, [selectedMapId]);

  const hasRoundInput = useMemo(() => {
    const roundDrops = normalizeRoundInput(selectedMap, roundValues);
    return hasDrops(roundDrops);
  }, [roundValues, selectedMap]);

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
  }

  function handleSaveRound(event) {
    event.preventDefault();

    if (!selectedPlayer) {
      return;
    }

    const roundDrops = normalizeRoundInput(selectedMap, roundValues);

    if (!hasDrops(roundDrops)) {
      setRoundFeedback("Enter at least one drop before saving a round.");
      return;
    }

    setPlayers((currentPlayers) =>
      currentPlayers.map((player) =>
        player.id === selectedPlayer.id ? applyRound(player, selectedMap.id, roundDrops) : player
      )
    );
    setRoundValues(
      selectedMap.items.reduce((accumulator, item) => {
        accumulator[item.id] = "";
        return accumulator;
      }, {})
    );
    setRoundFeedback(`Round ${selectedPlayer.maps[selectedMap.id].rounds + 1} saved.`);
  }

  function handleResetMap() {
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
    setRoundFeedback(`${selectedMap.name} progress reset for ${selectedPlayer.name}.`);
  }

  function handleDeletePlayer(playerId) {
    setPlayers((currentPlayers) => currentPlayers.filter((player) => player.id !== playerId));
  }

  const metadataMap = apiState.maps.find((map) => map.id === selectedMap.id);
  const mapProgress = selectedPlayer?.maps[selectedMap.id];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-card">
          <p className="eyebrow">4Vision farm loop tracker</p>
          <h1>FarmTracks</h1>
          <p className="muted">
            Save each player in the browser, log every round, and watch stacks build toward 200.
          </p>
        </div>

        <form className="player-form" onSubmit={handleAddPlayer}>
          <label htmlFor="playerName">New player</label>
          <div className="inline-form">
            <input
              id="playerName"
              value={newPlayerName}
              onChange={(event) => setNewPlayerName(event.target.value)}
              placeholder="Enter player name"
            />
            <button type="submit">Add</button>
          </div>
        </form>

        <section className="players-panel">
          <div className="section-heading">
            <h2>Players</h2>
            <span>{players.length}</span>
          </div>

          {players.length === 0 ? (
            <p className="empty-state">Create a player to start tracking rounds.</p>
          ) : (
            <div className="player-list">
              {players.map((player) => (
                <article
                  key={player.id}
                  className={`player-card ${player.id === selectedPlayerId ? "selected" : ""}`}
                >
                  <button type="button" className="player-select" onClick={() => setSelectedPlayerId(player.id)}>
                    <strong>{player.name}</strong>
                    <span>
                      {player.maps.narwashi.rounds + player.maps.arahur.rounds}
                      {" "}
                      total rounds
                    </span>
                  </button>
                  <button
                    type="button"
                    className="ghost-button danger"
                    onClick={() => handleDeletePlayer(player.id)}
                  >
                    Remove
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>

        {storageError ? <p className="warning-text">Browser save issue: {storageError}</p> : null}
      </aside>

      <main className="main-panel">
        <section className="hero-panel">
          <div>
            <p className="eyebrow">Route-driven tracking</p>
            <h2>{selectedMap.name}</h2>
            <p className="muted">{selectedMap.subtitle}</p>
          </div>

          <div className="map-tabs">
            {MAPS.map((map) => (
              <button
                key={map.id}
                type="button"
                className={map.id === selectedMapId ? "active" : ""}
                onClick={() => setSelectedMapId(map.id)}
              >
                {map.name}
              </button>
            ))}
          </div>
        </section>

        <section className="dashboard-grid">
          <article className="panel panel-accent">
            <div className="section-heading">
              <h3>Current route</h3>
              <span>{selectedPlayer ? selectedPlayer.name : "No player selected"}</span>
            </div>
            <p className="muted">{selectedMap.note}</p>
            <p className="muted">
              {metadataMap?.notes ?? "Metadata server unavailable. Tracking still works from browser storage."}
            </p>
            <div className="stat-strip">
              <div>
                <span>Rounds</span>
                <strong>{mapProgress?.rounds ?? 0}</strong>
              </div>
              <div>
                <span>Items tracked</span>
                <strong>{selectedMap.items.length}</strong>
              </div>
              <div>
                <span>API</span>
                <strong>{apiState.loading ? "Loading" : apiState.error ? "Offline" : "Ready"}</strong>
              </div>
            </div>
          </article>

          <article className="panel">
            <div className="section-heading">
              <h3>Log one round</h3>
              <button type="button" className="ghost-button" onClick={handleResetMap} disabled={!selectedPlayer}>
                Reset map
              </button>
            </div>

            {!selectedPlayer ? (
              <p className="empty-state">Select or create a player before logging drops.</p>
            ) : (
              <form className="round-form" onSubmit={handleSaveRound}>
                {selectedMap.items.map((item) => (
                  <label key={item.id} className="field-row">
                    <span>{item.name}</span>
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
                <button type="submit" disabled={!hasRoundInput}>
                  Save round
                </button>
                {roundFeedback ? <p className="helper-text">{roundFeedback}</p> : null}
              </form>
            )}
          </article>

          <article className="panel span-two">
            <div className="section-heading">
              <h3>Stack progress</h3>
              <span>200 per stack</span>
            </div>

            {!selectedPlayer ? (
              <p className="empty-state">Player totals will appear here.</p>
            ) : (
              <div className="progress-grid">
                {selectedMap.items.map((item) => {
                  const total = mapProgress?.totals[item.id] ?? 0;
                  const progress = getStackProgress(total);

                  return (
                    <article className="progress-card" key={item.id}>
                      <div className="progress-header">
                        <div>
                          <h4>{item.name}</h4>
                          <p>{total} total</p>
                        </div>
                        <strong>{progress.fullStacks} stacks</strong>
                      </div>
                      <div className="progress-bar">
                        <div
                          className="progress-fill"
                          style={{ width: `${progress.percent}%`, background: item.color }}
                        />
                      </div>
                      <p className="muted">{progress.remainder} / 200 into the next stack</p>
                    </article>
                  );
                })}
              </div>
            )}
          </article>

          <article className="panel span-two">
            <div className="section-heading">
              <h3>Recent rounds</h3>
              <span>Latest 12</span>
            </div>

            {!selectedPlayer || !mapProgress || mapProgress.history.length === 0 ? (
              <p className="empty-state">Rounds you save will appear here in reverse order.</p>
            ) : (
              <div className="history-list">
                {mapProgress.history.map((entry) => (
                  <article key={entry.id} className="history-card">
                    <div className="history-head">
                      <strong>Round {entry.round}</strong>
                      <span>{new Date(entry.createdAt).toLocaleString()}</span>
                    </div>
                    <div className="history-items">
                      {selectedMap.items.map((item) => (
                        <span key={item.id}>
                          {item.name}: {entry.drops[item.id] ?? 0}
                        </span>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </article>
        </section>
      </main>
    </div>
  );
}

export default App;
