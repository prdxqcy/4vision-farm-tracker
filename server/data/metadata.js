module.exports = {
  app: {
    name: "FarmTracks",
    storageStrategy: "browser-local",
    backendRole: "metadata-and-service-health",
    notes: [
      "Frontend map and item state should remain persisted in the browser.",
      "This API is intentionally minimal so future shared/server features can be added without breaking client storage."
    ]
  },
  resources: {
    map: {
      version: 1,
      fields: ["id", "name", "drops", "notes"]
    },
    item: {
      version: 1,
      fields: ["id", "name", "stackSize", "color"]
    }
  },
  maps: [
    {
      id: "narwashi",
      name: "Narwashi",
      mode: "rounds",
      notes: "Run the same circular route each round and record drops after each clear.",
      drops: [
        {
          id: "crystals",
          name: "Crystals",
          stackSize: 200,
          color: "#5ec4ff"
        },
        {
          id: "arcanes",
          name: "Arcanes",
          stackSize: 200,
          color: "#c18bff"
        },
        {
          id: "speed-potions",
          name: "Speed Potions",
          stackSize: 200,
          color: "#ffe36e"
        }
      ]
    },
    {
      id: "arahur",
      name: "Arahur",
      mode: "rounds",
      notes: "Track each loop of the route and the loot earned before starting the next round.",
      drops: [
        {
          id: "arahur-chests",
          name: "Arahur Chests",
          stackSize: 200,
          color: "#ff9f68"
        },
        {
          id: "ectoplasm",
          name: "Ectoplasm",
          stackSize: 200,
          color: "#80e9cc"
        },
        {
          id: "whips",
          name: "Whips",
          stackSize: 200,
          color: "#ff7f9f"
        },
        {
          id: "herbs-green",
          name: "Herbs (Green)",
          stackSize: 200,
          color: "#67d678"
        },
        {
          id: "herbs-blue",
          name: "Herbs (Blue)",
          stackSize: 200,
          color: "#6ea8ff"
        },
        {
          id: "herbs-red",
          name: "Herbs (Red)",
          stackSize: 200,
          color: "#ff6b6b"
        }
      ]
    }
  ],
  api: {
    version: "v1",
    endpoints: [
      {
        method: "GET",
        path: "/api/health",
        purpose: "Service health and uptime"
      },
      {
        method: "GET",
        path: "/api/metadata",
        purpose: "Static map/item metadata contract for the frontend"
      }
    ]
  }
};
