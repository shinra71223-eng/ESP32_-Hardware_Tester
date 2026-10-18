"""Convert videos into the demo clip blob (demo/clips.bin) and manage LED source library (library/*.ledbin).

Blob layout (little endian):
  'DMO1' | u16 width | u16 height | u8 fps | u8 clipCount | u16 frames[clipCount]
  then for each clip: frames x (width*height*3) RGB bytes, row-major from top-left.
The firmware applies ZIGZAG / START_POS mapping and fade in/out at runtime.
"""
import os
import json
import time
import uuid
import struct
import base64

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEMO_DIR = os.path.join(BASE_DIR, "demo")
BLOB_PATH = os.path.join(DEMO_DIR, "clips.bin")
LIBRARY_DIR = os.path.join(BASE_DIR, "library")


def apply_led_color_grading(rgb, gamma=1.0, contrast=1.0, saturation=1.0, black_cutoff=0):
    """Apply LED-optimized color grading (contrast, saturation, gamma correction, black cutoff) on RGB uint8 array."""
    import cv2
    import numpy as np
    out = rgb.astype(np.float32)

    # 1. Contrast around midpoint 127.5
    if abs(contrast - 1.0) > 1e-3:
        out = (out - 127.5) * float(contrast) + 127.5
        out = np.clip(out, 0, 255)

    # 2. Saturation adjustment in HSV space
    if abs(saturation - 1.0) > 1e-3:
        hsv = cv2.cvtColor(out.astype(np.uint8), cv2.COLOR_RGB2HSV).astype(np.float32)
        hsv[:, :, 1] = np.clip(hsv[:, :, 1] * float(saturation), 0, 255)
        out = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2RGB).astype(np.float32)

    # 3. Gamma correction (vital for WS2812B LEDs so midtones don't wash out)
    if abs(gamma - 1.0) > 1e-3 and gamma > 0:
        norm = np.clip(out / 255.0, 0.0, 1.0)
        out = np.power(norm, float(gamma)) * 255.0

    res = np.clip(out, 0, 255).astype(np.uint8)

    # 4. Black cutoff threshold (crush low-level compression noise to pure 0,0,0)
    if black_cutoff and int(black_cutoff) > 0:
        cutoff = int(black_cutoff)
        mask = np.max(res, axis=2) <= cutoff
        res[mask] = 0

    return res


def fit_frame(frame, w, h, fit="crop", gamma=1.0, contrast=1.0, saturation=1.0,
              black_cutoff=0, offset_x=0.0, offset_y=0.0, zoom=1.0):
    """Convert BGR frame to (h, w, 3) uint8 RGB using stretch/crop/letterbox + LED color grading."""
    import cv2
    import numpy as np
    sh, sw = frame.shape[:2]
    zoom = max(0.2, min(4.0, float(zoom or 1.0)))
    offset_x = max(-1.0, min(1.0, float(offset_x or 0.0)))
    offset_y = max(-1.0, min(1.0, float(offset_y or 0.0)))

    if fit == "stretch":
        out = cv2.resize(frame, (w, h), interpolation=cv2.INTER_AREA)
    else:
        base_scale = max(w / sw, h / sh) if fit == "crop" else min(w / sw, h / sh)
        scale = base_scale * zoom
        nw, nh = max(1, round(sw * scale)), max(1, round(sh * scale))
        res = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_AREA)
        if fit == "crop" or (nw >= w and nh >= h):
            max_dx = max(0, nw - w)
            max_dy = max(0, nh - h)
            x0 = int(round((max_dx / 2.0) * (1.0 + offset_x)))
            y0 = int(round((max_dy / 2.0) * (1.0 + offset_y)))
            x0 = max(0, min(max_dx, x0))
            y0 = max(0, min(max_dy, y0))
            out = res[y0:y0 + h, x0:x0 + w]
            if out.shape[0] != h or out.shape[1] != w:
                out = cv2.resize(out, (w, h), interpolation=cv2.INTER_AREA)
        else:  # letterbox (black bars)
            out = np.zeros((h, w, 3), dtype=np.uint8)
            cw, ch = min(nw, w), min(nh, h)
            sx0 = max(0, (nw - cw) // 2)
            sy0 = max(0, (nh - ch) // 2)
            crop_res = res[sy0:sy0 + ch, sx0:sx0 + cw]
            x0 = max(0, min(w - cw, int(round(((w - cw) / 2.0) * (1.0 + offset_x)))))
            y0 = max(0, min(h - ch, int(round(((h - ch) / 2.0) * (1.0 + offset_y)))))
            out[y0:y0 + ch, x0:x0 + cw] = crop_res

    rgb = cv2.cvtColor(out, cv2.COLOR_BGR2RGB)
    if gamma != 1.0 or contrast != 1.0 or saturation != 1.0 or black_cutoff > 0:
        rgb = apply_led_color_grading(rgb, gamma=gamma, contrast=contrast,
                                      saturation=saturation, black_cutoff=black_cutoff)
    return rgb


def write_empty_blob():
    os.makedirs(DEMO_DIR, exist_ok=True)
    with open(BLOB_PATH, "wb") as f:
        f.write(b"DMO1" + struct.pack("<HHBB", 0, 0, 30, 0))


def read_ledbin(path):
    """Read a DMO1 / .ledbin file and return dict(width, height, fps, frames=[bytes...])."""
    with open(path, "rb") as f:
        data = f.read()
    if len(data) < 10 or data[:4] != b"DMO1":
        raise RuntimeError(f"無効な ledbin ファイルです: {path}")
    w, h, fps, clip_count = struct.unpack("<HHBB", data[4:10])
    if clip_count == 0:
        return {"width": w, "height": h, "fps": fps, "frames": []}
    frame_counts = struct.unpack(f"<{clip_count}H", data[10:10 + 2 * clip_count])
    total_frames = sum(frame_counts)
    frame_bytes = w * h * 3
    offset = 10 + 2 * clip_count
    frames = []
    for _ in range(total_frames):
        if offset + frame_bytes <= len(data):
            frames.append(data[offset:offset + frame_bytes])
            offset += frame_bytes
    return {"width": w, "height": h, "fps": fps, "frames": frames}


def build_blob(paths, width, height, fit="crop", fps=30, max_bytes=None,
               gamma=1.0, contrast=1.0, saturation=1.0, black_cutoff=0):
    """Convert videos or .ledbin files to the firmware demo blob."""
    import cv2
    import numpy as np
    os.makedirs(DEMO_DIR, exist_ok=True)
    clips = []
    for p in paths:
        if not os.path.exists(p):
            # Try resolving inside library/
            candidate = os.path.join(LIBRARY_DIR, p)
            if os.path.exists(candidate):
                p = candidate
        if p.lower().endswith(".ledbin"):
            lb = read_ledbin(p)
            if lb["width"] == width and lb["height"] == height:
                frames = lb["frames"]
            else:
                # Resize frames if library clip has different resolution
                frames = []
                for fb in lb["frames"]:
                    arr = np.frombuffer(fb, dtype=np.uint8).reshape((lb["height"], lb["width"], 3))
                    bgr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
                    frames.append(fit_frame(bgr, width, height, fit).tobytes())
            if not frames:
                raise RuntimeError(f"フレームがありません: {p}")
            clips.append({"path": p, "frames": frames})
            continue

        cap = cv2.VideoCapture(p)
        if not cap.isOpened():
            raise RuntimeError(f"動画を開けません: {p}")
        src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        step = src_fps / fps
        frames, idx, nxt = [], 0, 0.0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if idx >= nxt - 1e-6:
                frames.append(fit_frame(
                    frame, width, height, fit,
                    gamma=gamma, contrast=contrast, saturation=saturation, black_cutoff=black_cutoff
                ).tobytes())
                nxt += step
            idx += 1
        cap.release()
        if not frames:
            raise RuntimeError(f"フレームがありません: {p}")
        clips.append({"path": p, "frames": frames})

    total = sum(len(f) for c in clips for f in c["frames"]) + 8 + 2 + 2 * len(clips)
    if max_bytes and total > max_bytes:
        raise RuntimeError(f"デモ動画が大きすぎます: {total/1e6:.2f}MB > {max_bytes/1e6:.2f}MB")

    with open(BLOB_PATH, "wb") as f:
        f.write(b"DMO1" + struct.pack("<HHBB", width, height, fps, len(clips)))
        for c in clips:
            f.write(struct.pack("<H", len(c["frames"])))
        for c in clips:
            for fr in c["frames"]:
                f.write(fr)
    return {"clips": [{"path": c["path"], "frames": len(c["frames"])} for c in clips],
            "bytes": total}


def convert_to_library(src_path, title=None, width=36, height=24, fit="crop", fps=30,
                       gamma=2.2, contrast=1.1, saturation=1.1, black_cutoff=5,
                       offset_x=0.0, offset_y=0.0, zoom=1.0, trim_start=0.0, trim_end=0.0):
    """Convert a video file into an optimized .ledbin item in library/ for PC & Smartphone playback."""
    import cv2
    import numpy as np
    os.makedirs(LIBRARY_DIR, exist_ok=True)
    cap = cv2.VideoCapture(src_path)
    if not cap.isOpened():
        raise RuntimeError(f"動画を開けません: {src_path}")

    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_src_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    src_duration = total_src_frames / src_fps if src_fps > 0 else 0

    start_frame = int(max(0.0, float(trim_start or 0.0)) * src_fps)
    end_frame = int(float(trim_end) * src_fps) if (trim_end and float(trim_end) > 0) else total_src_frames
    if end_frame <= start_frame:
        end_frame = total_src_frames

    if start_frame > 0:
        cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)

    step = max(0.1, src_fps / float(fps))
    frames = []
    thumb_rgb = None
    idx = start_frame
    nxt = float(start_frame)

    while idx < end_frame:
        ok, frame = cap.read()
        if not ok:
            break
        if idx >= nxt - 1e-6:
            rgb = fit_frame(
                frame, width, height, fit=fit,
                gamma=gamma, contrast=contrast, saturation=saturation,
                black_cutoff=black_cutoff, offset_x=offset_x, offset_y=offset_y, zoom=zoom
            )
            if thumb_rgb is None or len(frames) == 5:
                thumb_rgb = rgb.copy()
            frames.append(rgb.tobytes())
            nxt += step
        idx += 1
    cap.release()

    if not frames:
        raise RuntimeError("変換後のフレームが0件です。トリム範囲を確認してください。")

    item_id = f"clip_{int(time.time())}_{uuid.uuid4().hex[:6]}"
    ledbin_filename = f"{item_id}.ledbin"
    ledbin_path = os.path.join(LIBRARY_DIR, ledbin_filename)

    with open(ledbin_path, "wb") as f:
        f.write(b"DMO1" + struct.pack("<HHBB", width, height, int(fps), 1))
        f.write(struct.pack("<H", len(frames)))
        for fr in frames:
            f.write(fr)

    # Generate pixelated thumbnail PNG as base64
    scale = max(1, min(12, 240 // max(1, width)))
    big_bgr = cv2.resize(
        cv2.cvtColor(thumb_rgb, cv2.COLOR_RGB2BGR),
        (width * scale, height * scale),
        interpolation=cv2.INTER_NEAREST
    )
    _, png = cv2.imencode(".png", big_bgr)
    thumb_b64 = "data:image/png;base64," + base64.b64encode(png.tobytes()).decode()

    size_bytes = os.path.getsize(ledbin_path)
    meta = {
        "id": item_id,
        "title": title or os.path.splitext(os.path.basename(src_path))[0],
        "filename": ledbin_filename,
        "width": int(width),
        "height": int(height),
        "fps": int(fps),
        "frames": len(frames),
        "duration_sec": round(len(frames) / float(fps), 2),
        "size_bytes": size_bytes,
        "gamma": float(gamma),
        "contrast": float(contrast),
        "saturation": float(saturation),
        "black_cutoff": int(black_cutoff),
        "fit": fit,
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "thumbnail": thumb_b64
    }

    with open(os.path.join(LIBRARY_DIR, f"{item_id}.json"), "w", encoding="utf-8") as jf:
        json.dump(meta, jf, ensure_ascii=False, indent=2)

    return meta


def save_raw_frames_to_library(frames_rgb_bytes, width, height, fps=30, title="Custom Art"):
    """Save raw RGB frame list (from Pixel Art Pad or Text Marquee) as a .ledbin library item."""
    import cv2
    import numpy as np
    os.makedirs(LIBRARY_DIR, exist_ok=True)
    if not frames_rgb_bytes:
        raise RuntimeError("フレームが空です")

    item_id = f"art_{int(time.time())}_{uuid.uuid4().hex[:6]}"
    ledbin_filename = f"{item_id}.ledbin"
    ledbin_path = os.path.join(LIBRARY_DIR, ledbin_filename)

    with open(ledbin_path, "wb") as f:
        f.write(b"DMO1" + struct.pack("<HHBB", int(width), int(height), int(fps), 1))
        f.write(struct.pack("<H", len(frames_rgb_bytes)))
        for fr in frames_rgb_bytes:
            f.write(fr)

    first_rgb = np.frombuffer(frames_rgb_bytes[0], dtype=np.uint8).reshape((int(height), int(width), 3))
    scale = max(1, min(12, 240 // max(1, int(width))))
    big_bgr = cv2.resize(
        cv2.cvtColor(first_rgb, cv2.COLOR_RGB2BGR),
        (int(width) * scale, int(height) * scale),
        interpolation=cv2.INTER_NEAREST
    )
    _, png = cv2.imencode(".png", big_bgr)
    thumb_b64 = "data:image/png;base64," + base64.b64encode(png.tobytes()).decode()

    meta = {
        "id": item_id,
        "title": title,
        "filename": ledbin_filename,
        "width": int(width),
        "height": int(height),
        "fps": int(fps),
        "frames": len(frames_rgb_bytes),
        "duration_sec": round(len(frames_rgb_bytes) / float(fps), 2),
        "size_bytes": os.path.getsize(ledbin_path),
        "gamma": 1.0,
        "fit": "custom",
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "thumbnail": thumb_b64
    }
    with open(os.path.join(LIBRARY_DIR, f"{item_id}.json"), "w", encoding="utf-8") as jf:
        json.dump(meta, jf, ensure_ascii=False, indent=2)
    return meta


def list_library():
    """Return all saved library items sorted newest first."""
    os.makedirs(LIBRARY_DIR, exist_ok=True)
    items = []
    for fname in os.listdir(LIBRARY_DIR):
        if fname.endswith(".json"):
            jpath = os.path.join(LIBRARY_DIR, fname)
            try:
                with open(jpath, "r", encoding="utf-8") as f:
                    meta = json.load(f)
                bin_path = os.path.join(LIBRARY_DIR, meta.get("filename", ""))
                if os.path.exists(bin_path):
                    items.append(meta)
            except Exception:
                pass
    items.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return items


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 4:
        print("usage: python demo_builder.py WIDTH HEIGHT video1 [video2 ...]")
        sys.exit(1)
    print(build_blob(sys.argv[3:], int(sys.argv[1]), int(sys.argv[2])))
