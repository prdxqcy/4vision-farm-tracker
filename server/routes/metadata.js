const express = require("express");

const metadata = require("../data/metadata");

const router = express.Router();

router.get("/", (_req, res) => {
  res.json(metadata);
});

module.exports = router;
