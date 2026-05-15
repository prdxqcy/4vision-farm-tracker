import { MAPS, STACK_SIZE } from "./mapConfig";

function generateId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
    return [
      hex.slice(0, 4).join(""),
      hex.slice(4, 6).join(""),
      hex.slice(6, 8).join(""),
      hex.slice(8, 10).join(""),
      hex.slice(10, 16).join("")
    ].join("-");
  }

  return `ft-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export function createEmptyTotals(items) {
  return items.reduce((accumulator, item) => {
    accumulator[item.id] = 0;
    return accumulator;
  }, {});
}

export function createEmptyMapState(items) {
  const emptyTotals = createEmptyTotals(items);

  return {
    startedAt: new Date().toISOString(),
    rounds: 0,
    totals: emptyTotals,
    currentSnapshot: { ...emptyTotals },
    history: [],
    sessions: []
  };
}

export function createNewPlayer(name) {
  const trimmedName = name.trim();
  const mapState = MAPS.reduce((accumulator, map) => {
    accumulator[map.id] = createEmptyMapState(map.items);
    return accumulator;
  }, {});

  return {
    id: generateId(),
    name: trimmedName,
    createdAt: new Date().toISOString(),
    maps: mapState
  };
}

export function normalizeRoundInput(map, values) {
  const snapshotTotals = {};

  for (const item of map.items) {
    const stacksValue = Number.parseInt(values[item.id]?.stacks ?? 0, 10);
    const looseValue = Number.parseInt(values[item.id]?.loose ?? 0, 10);
    const stacks = Number.isFinite(stacksValue) && stacksValue > 0 ? stacksValue : 0;
    const loose = Number.isFinite(looseValue) && looseValue > 0 ? looseValue : 0;

    snapshotTotals[item.id] = (stacks * STACK_SIZE) + Math.min(loose, STACK_SIZE - 1);
  }

  return snapshotTotals;
}

export function getRoundGains(previousSnapshot, nextSnapshot) {
  return Object.keys(nextSnapshot).reduce((accumulator, itemId) => {
    accumulator[itemId] = nextSnapshot[itemId] - (previousSnapshot[itemId] ?? 0);
    return accumulator;
  }, {});
}

export function hasPositiveGain(gains) {
  return Object.values(gains).some((amount) => amount > 0);
}

export function hasNegativeGain(gains) {
  return Object.values(gains).some((amount) => amount < 0);
}

export function applyRound(player, mapId, snapshotTotals) {
  const nextPlayer = structuredClone(player);
  const mapState = nextPlayer.maps[mapId];

  if (!mapState) {
    return player;
  }

  const previousSnapshot = mapState.currentSnapshot ?? createEmptyTotals(
    Object.keys(snapshotTotals).map((itemId) => ({ id: itemId }))
  );
  const roundGains = getRoundGains(previousSnapshot, snapshotTotals);
  const nextTotals = { ...mapState.totals };

  Object.entries(roundGains).forEach(([itemId, amount]) => {
    nextTotals[itemId] = (nextTotals[itemId] ?? 0) + amount;
  });

  mapState.rounds += 1;
  mapState.totals = nextTotals;
  mapState.currentSnapshot = snapshotTotals;
  mapState.history = [
    {
      id: generateId(),
      round: mapState.rounds,
      gains: roundGains,
      snapshot: snapshotTotals,
      createdAt: new Date().toISOString()
    },
    ...mapState.history
  ].slice(0, 12);

  return nextPlayer;
}

export function resetMapProgress(player, mapId, items) {
  const nextPlayer = structuredClone(player);
  nextPlayer.maps[mapId] = createEmptyMapState(items);
  return nextPlayer;
}

export function finishSession(player, mapId, items) {
  const nextPlayer = structuredClone(player);
  const mapState = nextPlayer.maps[mapId];

  if (!mapState || mapState.rounds === 0) {
    return player;
  }

  const archivedSession = {
    id: generateId(),
    startedAt: mapState.startedAt,
    finishedAt: new Date().toISOString(),
    rounds: mapState.rounds,
    totals: { ...mapState.totals }
  };

  nextPlayer.maps[mapId] = {
    ...createEmptyMapState(items),
    sessions: [archivedSession, ...(mapState.sessions ?? [])].slice(0, 8)
  };

  return nextPlayer;
}

export function getStackProgress(amount) {
  const fullStacks = Math.floor(amount / STACK_SIZE);
  const remainder = amount % STACK_SIZE;
  const percent = Math.min(100, (remainder / STACK_SIZE) * 100);

  return {
    fullStacks,
    remainder,
    percent
  };
}

export function hasDrops(roundDrops) {
  return Object.values(roundDrops).some((amount) => amount > 0);
}

export function getTotalItems(totals) {
  return Object.values(totals).reduce((sum, value) => sum + value, 0);
}
