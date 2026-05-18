import json
import queue
import re
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

import mss
import numpy as np
from PIL import Image, ImageOps
from rapidocr_onnxruntime import RapidOCR


NUMBER_PATTERN = re.compile(r"-?\d+(?:[.,]\d+)?")


@dataclass
class ScannerConfig:
    trackers: dict
    poll_interval_ms: int = 650


config = ScannerConfig(trackers={})
config_lock = threading.Lock()
command_queue: "queue.Queue[dict]" = queue.Queue()
ocr = RapidOCR()


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def emit_scan(snapshot: dict) -> None:
    emit({
        "type": "scan",
        "ok": True,
        "snapshot": snapshot,
        "matches": [],
        "debug": {
            "provider": "rapidocr",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    })


def emit_status(status: str, detail: str = "") -> None:
    emit({
        "type": "status",
        "ok": True,
        "status": status,
        "detail": detail,
        "debug": {
            "provider": "rapidocr",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    })


def emit_error(message: str) -> None:
    emit({"type": "error", "ok": False, "message": message, "debug": {}})


def normalize_image(image: Image.Image) -> np.ndarray:
    gray = ImageOps.grayscale(image)
    enlarged = gray.resize((gray.width * 2, gray.height * 2))
    contrasted = ImageOps.autocontrast(enlarged)
    binary = contrasted.point(lambda p: 255 if p > 145 else 0)
    return np.array(binary)


def extract_number(image: Image.Image) -> tuple[Optional[float], str]:
    result, _ = ocr(normalize_image(image), use_det=True, use_cls=False, use_rec=True)
    parts = []
    if result:
        for item in result:
            text = item[1]
            if text:
                parts.append(text.strip())
    raw_text = " ".join(parts)
    matches = NUMBER_PATTERN.findall(raw_text)
    if not matches:
        return None, raw_text
    candidate = matches[-1].replace(",", ".")
    try:
        return float(candidate), raw_text
    except ValueError:
        return None, raw_text


def read_commands() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            command_queue.put(json.loads(line))
        except json.JSONDecodeError as error:
            emit_error(f"Invalid config payload: {error}")


def update_config() -> None:
    while True:
        try:
            command = command_queue.get_nowait()
        except queue.Empty:
            break
        if command.get("type") != "config":
            continue
        with config_lock:
            config.trackers = command.get("trackers", {})
            config.poll_interval_ms = max(150, int(command.get("pollIntervalMs", 650)))


def capture_loop() -> None:
    last_state = None
    emit_status("starting", "Python capture worker initialised")

    with mss.mss() as sct:
        while True:
            update_config()
            with config_lock:
                trackers = dict(config.trackers)
                poll_interval_ms = config.poll_interval_ms

            active_trackers = {
                key: tracker
                for key, tracker in trackers.items()
                if tracker and tracker.get("region")
            }

            if not active_trackers:
                if last_state != "waiting-for-region":
                    emit_status("waiting-for-region", "No scan regions configured")
                    last_state = "waiting-for-region"
                time.sleep(1.0)
                continue

            snapshot = {}
            try:
                for tracker_key, tracker in active_trackers.items():
                    region = tracker["region"]
                    monitor = {
                        "left": int(region["x"]),
                        "top": int(region["y"]),
                        "width": int(region["width"]),
                        "height": int(region["height"]),
                    }
                    screenshot = sct.grab(monitor)
                    image = Image.frombytes("RGB", screenshot.size, screenshot.rgb)
                    current_value, raw_text = extract_number(image)

                    if current_value is not None:
                        snapshot[tracker_key] = int(current_value)
                    else:
                        print(
                            f"OCR {tracker_key}: no number found, saw: {raw_text or '<empty>'}",
                            file=sys.stderr,
                            flush=True,
                        )

                if snapshot:
                    last_state = "scanning"
                    emit_scan(snapshot)

            except Exception as error:
                last_state = "error"
                emit_error(str(error))

            time.sleep(poll_interval_ms / 1000.0)


if __name__ == "__main__":
    reader = threading.Thread(target=read_commands, daemon=True)
    reader.start()
    capture_loop()
