# Item Templates

Place 28×28 px PNG template images here, named exactly:

- `crystals.png`
- `arcanes.png`
- `speed-potions.png`

These are used by `capture_worker.py` for OpenCV template matching.

**How to create them:**
1. Take a clear screenshot of the game with the items visible.
2. Crop a single item icon (approximately 28×28 px at your native resolution).
3. Save it here with the exact filename above.

The worker will run in stub mode (zero counts) until templates are present.
