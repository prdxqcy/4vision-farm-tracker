import { MAPS, STACK_SIZE } from "./mapConfig";

export function createEmptyTotals(items) {
  return items.reduce((accumulator, item) => {
    accumulator[item.id] = 0;
    return accumulator;
  }, {});
}

export function createNewPlayer(name) {
  const trimmedName = name.trim();
  const mapState = MAPS.reduce((accumulator, map) => {
    accumulator[map.id] = {
      rounds: 0,
      totals: createEmptyTotals(map.items),
      history: []
    };
    return accumulator;
  }, {});

  return {
    id: crypto.randomUUID(),
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
      id: crypto.randomUUID(),
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
  nextPlayer.maps[mapId] = {
    rounds: 0,
    totals: createEmptyTotals(items),
    history: []
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
