#!/usr/bin/env python3
import glob
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request

try:
    from evdev import InputDevice, categorize, ecodes, list_devices
except ImportError:
    print("[fatal] Missing python3-evdev. Re-run the installer.", flush=True)
    sys.exit(2)


ENV_FILE = "/etc/production-suite-scanner.env"
DEFAULT_SERVER_URL = "http://10.1.1.64:3001"
SCANNER_HINTS = (
    "scanner",
    "barcode",
    "reader",
    "honeywell",
    "zebra",
    "datalogic",
    "socket",
)
IGNORE_HINTS = (
    "gpio",
    "power button",
    "video bus",
    "vc4",
)

UNSHIFTED_KEYS = {
    "KEY_0": "0",
    "KEY_1": "1",
    "KEY_2": "2",
    "KEY_3": "3",
    "KEY_4": "4",
    "KEY_5": "5",
    "KEY_6": "6",
    "KEY_7": "7",
    "KEY_8": "8",
    "KEY_9": "9",
    "KEY_MINUS": "-",
    "KEY_EQUAL": "=",
    "KEY_DOT": ".",
    "KEY_COMMA": ",",
    "KEY_SLASH": "/",
    "KEY_SEMICOLON": ";",
    "KEY_APOSTROPHE": "'",
    "KEY_LEFTBRACE": "[",
    "KEY_RIGHTBRACE": "]",
    "KEY_BACKSLASH": "\\",
    "KEY_SPACE": " ",
    "KEY_GRAVE": "`",
    "KEY_KP0": "0",
    "KEY_KP1": "1",
    "KEY_KP2": "2",
    "KEY_KP3": "3",
    "KEY_KP4": "4",
    "KEY_KP5": "5",
    "KEY_KP6": "6",
    "KEY_KP7": "7",
    "KEY_KP8": "8",
    "KEY_KP9": "9",
    "KEY_KPSLASH": "/",
    "KEY_KPDOT": ".",
    "KEY_KPASTERISK": "*",
    "KEY_KPMINUS": "-",
    "KEY_KPPLUS": "+",
}

SHIFTED_KEYS = {
    "KEY_0": ")",
    "KEY_1": "!",
    "KEY_2": "@",
    "KEY_3": "#",
    "KEY_4": "$",
    "KEY_5": "%",
    "KEY_6": "^",
    "KEY_7": "&",
    "KEY_8": "*",
    "KEY_9": "(",
    "KEY_MINUS": "_",
    "KEY_EQUAL": "+",
    "KEY_DOT": ">",
    "KEY_COMMA": "<",
    "KEY_SLASH": "?",
    "KEY_SEMICOLON": ":",
    "KEY_APOSTROPHE": "\"",
    "KEY_LEFTBRACE": "{",
    "KEY_RIGHTBRACE": "}",
    "KEY_BACKSLASH": "|",
    "KEY_GRAVE": "~",
}


def load_env_file(path):
    if not os.path.exists(path):
        return
    try:
        with open(path, "r", encoding="utf-8") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except OSError as exc:
        print(f"[warn] Failed to read {path}: {exc}", flush=True)


load_env_file(ENV_FILE)

SERVER_URL = os.environ.get("SERVER_URL", DEFAULT_SERVER_URL).rstrip("/")
DEVICE_ID = os.environ.get("DEVICE_ID", socket.gethostname())
HOSTNAME = os.environ.get("DEVICE_HOSTNAME", socket.gethostname())
SCANNER_DEVICE = os.environ.get("SCANNER_DEVICE", "").strip()
SCANNER_NAME_MATCH = os.environ.get("SCANNER_NAME_MATCH", "").strip().lower()
REQUEST_TIMEOUT = float(os.environ.get("REQUEST_TIMEOUT_SECONDS", "10"))
RETRY_DELAY = float(os.environ.get("RETRY_DELAY_SECONDS", "3"))
ENDPOINT = f"{SERVER_URL}/api/device-scan"


def parse_json_bytes(data):
    if not data:
        return {}
    try:
        return json.loads(data.decode("utf-8"))
    except Exception:
        return {}


def path_score(path, name):
    joined = f"{path} {name}".lower()
    score = 0
    if any(hint in joined for hint in SCANNER_HINTS):
        score += 10
    if "by-id" in path:
        score += 3
    if "event-kbd" in path:
        score += 2
    return score


def key_to_char(keycode, shift_active):
    if keycode.startswith("KEY_") and len(keycode) == 5 and keycode[-1].isalpha():
        letter = keycode[-1]
        return letter.upper() if shift_active else letter.lower()
    if shift_active and keycode in SHIFTED_KEYS:
        return SHIFTED_KEYS[keycode]
    return UNSHIFTED_KEYS.get(keycode)


def list_candidates():
    candidates = []
    seen_paths = set()

    for path in sorted(glob.glob("/dev/input/by-id/*-event-kbd")):
        try:
            device = InputDevice(path)
        except OSError:
            continue
        name = (device.name or "").strip()
        lowered = f"{path} {name}".lower()
        if any(hint in lowered for hint in IGNORE_HINTS):
            device.close()
            continue
        real_path = os.path.realpath(path)
        if real_path in seen_paths:
            device.close()
            continue
        seen_paths.add(real_path)
        candidates.append({"path": path, "name": name, "score": path_score(path, name)})
        device.close()

    if candidates:
        return sorted(candidates, key=lambda item: (-item["score"], item["path"]))

    for path in list_devices():
        try:
            device = InputDevice(path)
        except OSError:
            continue
        name = (device.name or "").strip()
        lowered = f"{path} {name}".lower()
        if any(hint in lowered for hint in IGNORE_HINTS):
            device.close()
            continue
        caps = device.capabilities(verbose=False)
        if ecodes.EV_KEY not in caps:
            device.close()
            continue
        candidates.append({"path": path, "name": name, "score": path_score(path, name)})
        device.close()

    return sorted(candidates, key=lambda item: (-item["score"], item["path"]))


def choose_device():
    if SCANNER_DEVICE:
        return {"path": SCANNER_DEVICE, "name": os.path.basename(SCANNER_DEVICE)}

    candidates = list_candidates()
    if SCANNER_NAME_MATCH:
        filtered = [
            item
            for item in candidates
            if SCANNER_NAME_MATCH in item["path"].lower()
            or SCANNER_NAME_MATCH in item["name"].lower()
        ]
        if len(filtered) == 1:
            return filtered[0]
        if filtered:
            candidates = filtered

    scanner_like = [
        item
        for item in candidates
        if any(hint in f'{item["path"]} {item["name"]}'.lower() for hint in SCANNER_HINTS)
    ]
    if len(scanner_like) == 1:
        return scanner_like[0]
    if len(candidates) == 1:
        return candidates[0]

    details = ", ".join(f'{item["path"]} ({item["name"]})' for item in candidates) or "none"
    raise RuntimeError(
        "Unable to auto-select scanner input device. "
        f"Set SCANNER_DEVICE or SCANNER_NAME_MATCH. Candidates: {details}"
    )


def post_scan(scan_value):
    payload = {
        "deviceId": DEVICE_ID,
        "hostname": HOSTNAME,
        "scan": scan_value,
    }
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        ENDPOINT,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
            response_body = parse_json_bytes(response.read())
            if response_body.get("scanKind") == "material_stock":
                material_id = response_body.get("materialId", "?")
                print(f"[ok] material scan {scan_value} -> {material_id}", flush=True)
                return

            runlist_id = response_body.get("runlistId")
            machine_id = response_body.get("machineId")
            if runlist_id:
                print(
                    f"[ok] scan {scan_value} -> runlist {runlist_id} on machine {machine_id}",
                    flush=True,
                )
            else:
                print(f"[ok] scan {scan_value} accepted", flush=True)
    except urllib.error.HTTPError as exc:
        error_body = parse_json_bytes(exc.read())
        code = error_body.get("code")
        message = error_body.get("error") or exc.reason
        if code == "device_not_configured":
            print(f"[wait] {message}", flush=True)
            return
        if code == "device_disabled":
            print(f"[halt] {message}", flush=True)
            time.sleep(max(RETRY_DELAY, 10))
            return
        print(f"[error] HTTP {exc.code}: {message}", flush=True)
    except urllib.error.URLError as exc:
        print(f"[error] Could not reach {ENDPOINT}: {exc}", flush=True)
    except Exception as exc:
        print(f"[error] Failed to post scan: {exc}", flush=True)


def consume_device(device_info):
    path = device_info["path"]
    name = device_info.get("name") or path
    print(f"[info] Listening on {path} ({name})", flush=True)
    device = InputDevice(path)
    try:
        device.grab()
    except OSError:
        pass

    shift_active = False
    buffer = []
    try:
        for event in device.read_loop():
            if event.type != ecodes.EV_KEY:
                continue
            key_event = categorize(event)
            keycode = key_event.keycode
            if isinstance(keycode, list):
                keycode = next((item for item in keycode if item.startswith("KEY_")), keycode[0])

            if keycode in ("KEY_LEFTSHIFT", "KEY_RIGHTSHIFT"):
                shift_active = key_event.keystate != key_event.key_up
                continue

            if key_event.keystate != key_event.key_down:
                continue

            if keycode in ("KEY_ENTER", "KEY_KPENTER", "KEY_TAB"):
                scan_value = "".join(buffer).strip()
                buffer = []
                if scan_value:
                    post_scan(scan_value)
                continue

            if keycode == "KEY_BACKSPACE":
                if buffer:
                    buffer.pop()
                continue

            char = key_to_char(keycode, shift_active)
            if char:
                buffer.append(char)
    finally:
        try:
            device.ungrab()
        except OSError:
            pass
        device.close()


def main():
    print(
        f"[info] Production scanner client starting for deviceId={DEVICE_ID} server={SERVER_URL}",
        flush=True,
    )
    while True:
        try:
            device_info = choose_device()
            consume_device(device_info)
        except KeyboardInterrupt:
            print("[info] Stopping scanner client", flush=True)
            return
        except Exception as exc:
            print(f"[warn] {exc}", flush=True)
            time.sleep(RETRY_DELAY)


if __name__ == "__main__":
    main()
