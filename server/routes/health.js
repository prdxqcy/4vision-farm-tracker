const express = require("express");

const router = express.Router();

router.get("/", (_req, res) => {
  res.json({
    status: "ok",
    uptimeSeconds: Number(process.uptime().toFixed(3)),
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
