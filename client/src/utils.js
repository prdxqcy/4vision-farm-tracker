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
  return {
    startedAt: new Date().toISOString(),
    rounds: 0,
    totals: createEmptyTotals(items),
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
  const roundDrops = {};

  for (const item of map.items) {
    const rawValue = values[item.id];
    const parsedValue = Number.parseInt(rawValue ?? 0, 10);
    roundDrops[item.id] = Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : 0;
  }

  return roundDrops;
}

export function applyRound(player, mapId, roundDrops) {
  const nextPlayer = structuredClone(player);
  const mapState = nextPlayer.maps[mapId];

  if (!mapState) {
    return player;
  }

  const nextTotals = { ...mapState.totals };

  Object.entries(roundDrops).forEach(([itemId, amount]) => {
    nextTotals[itemId] = (nextTotals[itemId] ?? 0) + amount;
  });

  mapState.rounds += 1;
  mapState.totals = nextTotals;
  mapState.history = [
    {
      id: generateId(),
      round: mapState.rounds,
      drops: roundDrops,
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
