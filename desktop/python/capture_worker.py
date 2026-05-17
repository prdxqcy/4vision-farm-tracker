"""
FarmTracks Python Capture Worker
---------------------------------
Runs as a background process managed by Electron.
Continuously scans the game inventory and prints newline-delimited JSON to stdout.
Errors go to stderr or as JSON error messages to stdout.

Output schema (scan):
  {"type":"scan","ok":true,"snapshot":{...},"matches":[],"debug":{...}}

Output schema (error):
  {"type":"error","ok":false,"message":"...","debug":{}}

Item templates live in the "templates/" subdirectory beside this script.
Add PNG files named "<item_id>.png" and register them in ITEM_CONFIGS below.
"""

import sys
import os
import json
import time
import signal
import traceback
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Optional dependency imports with graceful degradation
# ---------------------------------------------------------------------------
try:
    import mss
    import mss.tools
    HAS_MSS = True
except ImportError:
    HAS_MSS = False
    print(json.dumps({
        "type": "error", "ok": False,
        "message": "mss not installed. Run: pip install mss",
        "debug": {}
    }), flush=True)

try:
    import cv2
    import numpy as np
    HAS_CV2 = True
except ImportError:
    HAS_CV2 = False

try:
    import pytesseract
    HAS_TESSERACT = True
except ImportError:
    HAS_TESSERACT = False

try:
    import easyocr
    HAS_EASYOCR = True
except ImportError:
    HAS_EASYOCR = False

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SCAN_INTERVAL_SECONDS = 2.5  # How often to scan (2–3 seconds as required)

# Locate the templates directory relative to this script (works both in dev
# and when compiled with PyInstaller via sys._MEIPASS).
if getattr(sys, "frozen", False):
    BASE_DIR = sys._MEIPASS  # type: ignore[attr-defined]
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
CONFIG_FILE = os.path.join(BASE_DIR, "capture_config.json")

# ---------------------------------------------------------------------------
# Item definitions
# Register items here. Each entry maps an item ID to its display name and
# how matches should be counted:
#   - "instances"  : count every match separately (e.g. crystals in slots)
#   - "best-stack" : read OCR stack number from the best match (e.g. arcanes)
# ---------------------------------------------------------------------------
ITEM_CONFIGS = [
    {
        "id": "crystals",
        "name": "Crystals",
        "count_mode": "instances",
        "max_matches": 10,
        "template_file": "crystals.png",
    },
    {
        "id": "arcanes",
        "name": "Arcanes",
        "count_mode": "best-stack",
        "max_matches": 3,
        "template_file": "arcane.png",
    },
    {
        "id": "speed-potions",
        "name": "Speed Potions",
        "count_mode": "best-stack",
        "max_matches": 3,
        "template_file": "speedpotions.png",
    },
]

# ---------------------------------------------------------------------------
# Template matching thresholds (tune after adding real templates)
# ---------------------------------------------------------------------------
MATCH_THRESHOLD = 0.60   # cv2.TM_CCOEFF_NORMED confidence (0–1, higher = stricter)
DEDUP_DISTANCE_PX = 20   # pixels; nearby duplicates within this radius are merged
SCALES = [0.88, 0.94, 1.0, 1.06, 1.12]  # multi-scale scan

# ---------------------------------------------------------------------------
# Calibration / scan region config
# Loaded from capture_config.json if present; otherwise the full primary
# monitor is used. The config file is written by Electron when the user runs
# the calibration flow in the React UI.
# ---------------------------------------------------------------------------

def load_config():
    """Load optional scan-region calibration from JSON config file."""
    if not os.path.isfile(CONFIG_FILE):
        return {}
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

# ---------------------------------------------------------------------------
# Screenshot capture
# ---------------------------------------------------------------------------

def capture_screenshot(config):
    """
    Capture the screen region defined in config (or full primary monitor).
    Returns a numpy BGR image array.
    """
    if not HAS_MSS:
        raise RuntimeError("mss is not installed")
    if not HAS_CV2:
        raise RuntimeError("opencv-python is not installed")

    region = config.get("scanRegion")

    with mss.mss() as sct:
        if region:
            monitor = {
                "top": int(region.get("y", 0)),
                "left": int(region.get("x", 0)),
                "width": int(region.get("width", 1920)),
                "height": int(region.get("height", 1080)),
            }
        else:
            monitor = sct.monitors[1]  # primary monitor

        raw = sct.grab(monitor)

    # mss returns BGRA; convert to BGR for OpenCV
    img = np.frombuffer(raw.raw, dtype=np.uint8)
    img = img.reshape((raw.height, raw.width, 4))
    return cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)

# ---------------------------------------------------------------------------
# Template loading
# ---------------------------------------------------------------------------

_template_cache: dict = {}

def load_template(item_config):
    """
    Load (and cache) the OpenCV template for a given item.
    Returns None if the template file does not exist yet — this allows the
    worker to start without any templates and emit zero counts.
    """
    tfile = os.path.join(TEMPLATES_DIR, item_config["template_file"])
    cache_key = tfile

    if cache_key in _template_cache:
        return _template_cache[cache_key]

    if not os.path.isfile(tfile):
        _template_cache[cache_key] = None
        return None

    tmpl = cv2.imread(tfile, cv2.IMREAD_COLOR)
    _template_cache[cache_key] = tmpl
    return tmpl

# ---------------------------------------------------------------------------
# Multi-scale template matching
# ---------------------------------------------------------------------------

def find_template_matches(screenshot, template, max_matches, threshold=MATCH_THRESHOLD):
    """
    Slide template over screenshot at multiple scales, return list of
    {"x", "y", "w", "h", "score", "scale"} dicts (best non-overlapping).
    """
    if template is None:
        return []

    gray_screen = cv2.cvtColor(screenshot, cv2.COLOR_BGR2GRAY)
    gray_tmpl_orig = cv2.cvtColor(template, cv2.COLOR_BGR2GRAY)

    candidates = []

    for scale in SCALES:
        h_orig, w_orig = gray_tmpl_orig.shape
        new_w = max(8, int(w_orig * scale))
        new_h = max(8, int(h_orig * scale))

        if new_w > gray_screen.shape[1] or new_h > gray_screen.shape[0]:
            continue

        scaled_tmpl = cv2.resize(gray_tmpl_orig, (new_w, new_h), interpolation=cv2.INTER_AREA)
        result = cv2.matchTemplate(gray_screen, scaled_tmpl, cv2.TM_CCOEFF_NORMED)

        # Collect all locations above threshold
        locations = np.where(result >= threshold)
        for pt_y, pt_x in zip(*locations):
            score = float(result[pt_y, pt_x])
            candidates.append({
                "x": int(pt_x),
                "y": int(pt_y),
                "w": new_w,
                "h": new_h,
                "score": score,
                "scale": scale,
            })

    # Sort by score descending, then deduplicate
    candidates.sort(key=lambda c: -c["score"])
    kept = []
    for cand in candidates:
        cx = cand["x"] + cand["w"] // 2
        cy = cand["y"] + cand["h"] // 2
        too_close = False
        for k in kept:
            kx = k["x"] + k["w"] // 2
            ky = k["y"] + k["h"] // 2
            if abs(cx - kx) < DEDUP_DISTANCE_PX and abs(cy - ky) < DEDUP_DISTANCE_PX:
                too_close = True
                break
        if not too_close:
            kept.append(cand)
        if len(kept) >= max_matches:
            break

    return kept

# ---------------------------------------------------------------------------
# OCR – read stack count from a region of the screenshot
# ---------------------------------------------------------------------------

def read_stack_count(screenshot, match):
    """
    Try to OCR a small region just below/around the matched slot to read
    the numeric stack count (0–999).
    Returns an integer, or 1 if OCR is unavailable or fails.
    """
    x = match["x"]
    y = match["y"]
    w = match["w"]
    h = match["h"]

    # Crop a slightly expanded region to capture the stack number overlay
    margin = 4
    x1 = max(0, x - margin)
    y1 = max(0, y - margin)
    x2 = min(screenshot.shape[1], x + w + margin)
    y2 = min(screenshot.shape[0], y + h + margin + 12)  # a bit below for the count
    roi = screenshot[y1:y2, x1:x2]

    if roi.size == 0:
        return 1

    if HAS_TESSERACT:
        try:
            gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
            _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
            config_str = "--psm 8 -c tessedit_char_whitelist=0123456789"
            text = pytesseract.image_to_string(thresh, config=config_str).strip()
            digits = "".join(ch for ch in text if ch.isdigit())
            if digits:
                return min(999, int(digits))
        except Exception:
            pass

    if HAS_EASYOCR:
        try:
            if not hasattr(read_stack_count, "_reader"):
                read_stack_count._reader = easyocr.Reader(["en"], gpu=False, verbose=False)
            results = read_stack_count._reader.readtext(roi, detail=0, allowlist="0123456789")
            for r in results:
                digits = "".join(ch for ch in r if ch.isdigit())
                if digits:
                    return min(999, int(digits))
        except Exception:
            pass

    return 1  # fallback: assume single item if OCR unavailable

# ---------------------------------------------------------------------------
# Main scan function
# ---------------------------------------------------------------------------

def scan_inventory(config):
    """
    Capture the screen and run template matching for all configured items.
    Returns (snapshot_dict, matches_list, debug_dict).
    """
    screenshot = capture_screenshot(config)
    snapshot = {}
    all_matches = []

    for item_cfg in ITEM_CONFIGS:
        template = load_template(item_cfg)
        matches = find_template_matches(
            screenshot, template,
            max_matches=item_cfg["max_matches"],
        )

        if item_cfg["count_mode"] == "instances":
            count = len(matches)
        elif item_cfg["count_mode"] == "best-stack":
            if matches:
                # Use OCR on the best (highest score) match
                best = max(matches, key=lambda m: m["score"])
                count = read_stack_count(screenshot, best)
            else:
                count = 0
        else:
            count = len(matches)

        snapshot[item_cfg["id"]] = count

        for m in matches:
            all_matches.append({
                "itemId": item_cfg["id"],
                "x": m["x"],
                "y": m["y"],
                "scale": m["scale"],
                "score": round(m["score"], 4),
            })

    h, w = screenshot.shape[:2]
    debug = {
        "provider": "python-opencv",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "screenshotSize": {"w": w, "h": h},
        "hasTemplates": [
            cfg["id"] for cfg in ITEM_CONFIGS
            if os.path.isfile(os.path.join(TEMPLATES_DIR, cfg["template_file"]))
        ],
        "missingTemplates": [
            cfg["id"] for cfg in ITEM_CONFIGS
            if not os.path.isfile(os.path.join(TEMPLATES_DIR, cfg["template_file"]))
        ],
        "hasCV2": HAS_CV2,
        "hasOCR": HAS_TESSERACT or HAS_EASYOCR,
    }

    return snapshot, all_matches, debug

# ---------------------------------------------------------------------------
# Emit helpers – always flush so Electron's readline stream fires immediately
# ---------------------------------------------------------------------------

def emit(payload: dict):
    print(json.dumps(payload, separators=(",", ":")), flush=True)

def emit_scan(snapshot, matches, debug):
    emit({
        "type": "scan",
        "ok": True,
        "snapshot": snapshot,
        "matches": matches,
        "debug": debug,
    })

def emit_error(message: str, debug: dict = None):
    emit({
        "type": "error",
        "ok": False,
        "message": message,
        "debug": debug or {},
    })

def emit_status(status: str, detail: str = ""):
    emit({
        "type": "status",
        "ok": True,
        "status": status,
        "detail": detail,
        "debug": {
            "provider": "python-opencv",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    })

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

_running = True

def handle_signal(signum, frame):
    global _running
    _running = False

signal.signal(signal.SIGTERM, handle_signal)
if hasattr(signal, "SIGBREAK"):
    signal.signal(signal.SIGBREAK, handle_signal)  # Windows Ctrl+Break

def main():
    global _running

    emit_status("starting", "Python capture worker initialised")

    if not HAS_MSS or not HAS_CV2:
        missing = []
        if not HAS_MSS:
            missing.append("mss")
        if not HAS_CV2:
            missing.append("opencv-python")
        emit_error(
            f"Missing required packages: {', '.join(missing)}. "
            "Worker will emit stub zero-count scans. "
            "Install missing packages and restart."
        )

    config = load_config()

    emit_status(
        "ready",
        f"Scan interval: {SCAN_INTERVAL_SECONDS}s. "
        f"Templates dir: {TEMPLATES_DIR}"
    )

    while _running:
        try:
            if HAS_MSS and HAS_CV2:
                snapshot, matches, debug = scan_inventory(config)
            else:
                # Stub mode: emit zero counts so UI shows scanner is alive
                snapshot = {cfg["id"]: 0 for cfg in ITEM_CONFIGS}
                matches = []
                debug = {
                    "provider": "python-stub",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "reason": "required packages not installed",
                }

            emit_scan(snapshot, matches, debug)

        except KeyboardInterrupt:
            break
        except Exception as exc:
            tb = traceback.format_exc()
            print(tb, file=sys.stderr, flush=True)
            emit_error(str(exc), {"traceback": tb[-500:]})

        # Sleep in short increments so SIGTERM is handled promptly
        deadline = time.monotonic() + SCAN_INTERVAL_SECONDS
        while _running and time.monotonic() < deadline:
            time.sleep(0.1)

    emit_status("stopped", "Worker shut down cleanly")

if __name__ == "__main__":
    main()
