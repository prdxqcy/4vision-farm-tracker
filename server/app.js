const express = require("express");
const cors = require("cors");
const path = require("path");

const healthRouter = require("./routes/health");
const metadataRouter = require("./routes/metadata");

const app = express();
const clientDistPath = path.join(__dirname, "..", "client", "dist");

app.use(cors());
app.use(express.json());

app.get("/api", (_req, res) => {
  res.json({
    name: "FarmTracks API",
    status: "ok",
    docs: {
      health: "/api/health",
      metadata: "/api/metadata"
    }
  });
});

app.use("/api/health", healthRouter);
app.use("/api/metadata", metadataRouter);

app.use(express.static(clientDistPath));

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) {
    next();
    return;
  }

  res.sendFile(path.join(clientDistPath, "index.html"));
});

app.use((req, res) => {
  res.status(404).json({
    error: "Not Found",
    message: `No route defined for ${req.method} ${req.originalUrl}`
  });
});

module.exports = app;
