import { MAPS } from "./mapConfig";
import { createEmptyMapState } from "./utils";

const STORAGE_KEY = "farmtracks.players.v1";

function createEmptyTotals(items) {
  return items.reduce((accumulator, item) => {
    accumulator[item.id] = 0;
    return accumulator;
  }, {});
}

function normalizeHistory(history, items) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter((entry) => entry && typeof entry === "object")
    .map((entry, index) => {
      const drops = items.reduce((accumulator, item) => {
        const value = Number.parseInt(entry.drops?.[item.id] ?? 0, 10);
        accumulator[item.id] = Number.isFinite(value) && value > 0 ? value : 0;
        return accumulator;
      }, {});

      return {
        id: typeof entry.id === "string" ? entry.id : `history-${index}`,
        round: Number.isFinite(entry.round) && entry.round > 0 ? entry.round : index + 1,
        createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString(),
        drops
      };
    })
    .slice(0, 12);
}

function normalizeSessions(sessions, items) {
  if (!Array.isArray(sessions)) {
    return [];
  }

  return sessions
    .filter((entry) => entry && typeof entry === "object")
    .map((entry, index) => {
      const totals = items.reduce((accumulator, item) => {
        const value = Number.parseInt(entry.totals?.[item.id] ?? 0, 10);
        accumulator[item.id] = Number.isFinite(value) && value > 0 ? value : 0;
        return accumulator;
      }, {});

      return {
        id: typeof entry.id === "string" ? entry.id : `session-${index}`,
        startedAt: typeof entry.startedAt === "string" ? entry.startedAt : new Date().toISOString(),
        finishedAt: typeof entry.finishedAt === "string" ? entry.finishedAt : new Date().toISOString(),
        rounds: Number.isFinite(entry.rounds) && entry.rounds > 0 ? entry.rounds : 0,
        totals
      };
    })
    .slice(0, 8);
}

function normalizePlayer(player, index) {
  if (!player || typeof player !== "object") {
    return null;
  }

  const name = typeof player.name === "string" ? player.name.trim() : "";

  if (!name) {
    return null;
  }

  const maps = MAPS.reduce((accumulator, map) => {
    const savedMap = player.maps?.[map.id] ?? {};
    const emptyState = createEmptyMapState(map.items);
    const totals = createEmptyTotals(map.items);

    for (const item of map.items) {
      const value = Number.parseInt(savedMap.totals?.[item.id] ?? 0, 10);
      totals[item.id] = Number.isFinite(value) && value > 0 ? value : 0;
    }

    accumulator[map.id] = {
      startedAt: typeof savedMap.startedAt === "string" ? savedMap.startedAt : emptyState.startedAt,
      rounds: Number.isFinite(savedMap.rounds) && savedMap.rounds > 0 ? savedMap.rounds : 0,
      totals,
      history: normalizeHistory(savedMap.history, map.items),
      sessions: normalizeSessions(savedMap.sessions, map.items)
    };

    return accumulator;
  }, {});

  return {
    id: typeof player.id === "string" ? player.id : `player-${index}-${name.toLowerCase()}`,
    name,
    createdAt: typeof player.createdAt === "string" ? player.createdAt : new Date().toISOString(),
    maps
  };
}

export function loadPlayers() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);

    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((player, index) => normalizePlayer(player, index))
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function savePlayers(players) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(players));
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : "Unable to save player data in this browser.";
  }
}
