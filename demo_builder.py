"""Convert videos into the demo clip blob (demo/clips.bin) embedded in the firmware.

Blob layout (little endian):
  'DMO1' | u16 width | u16 height | u8 fps | u8 clipCount | u16 frames[clipCount]
  then for each clip: frames x (width*height*3) RGB bytes, row-major from top-left.
The firmware applies ZIGZAG / START_POS mapping and fade in/out at runtime.
"""
import os
import struct

DEMO_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "demo")
BLOB_PATH = os.path.join(DEMO_DIR, "clips.bin")


def fit_frame(frame, w, h, fit):
    """Convert BGR frame to (h, w, 3) uint8 RGB using stretch/crop/letterbox."""
    import cv2
    import numpy as np
    sh, sw = frame.shape[:2]
    if fit == "stretch":
        out = cv2.resize(frame, (w, h), interpolation=cv2.INTER_AREA)
    else:
        scale = max(w / sw, h / sh) if fit == "crop" else min(w / sw, h / sh)
        nw, nh = max(1, round(sw * scale)), max(1, round(sh * scale))
        res = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_AREA)
        if fit == "crop":
            x0, y0 = (nw - w) // 2, (nh - h) // 2
            out = res[y0:y0 + h, x0:x0 + w]
            if out.shape[0] != h or out.shape[1] != w:
                out = cv2.resize(out, (w, h), interpolation=cv2.INTER_AREA)
        else:  # letterbox (black bars)
            out = np.zeros((h, w, 3), dtype=np.uint8)
            nw, nh = min(nw, w), min(nh, h)
            res = res[:nh, :nw]
            x0, y0 = (w - nw) // 2, (h - nh) // 2
            out[y0:y0 + nh, x0:x0 + nw] = res
    return cv2.cvtColor(out, cv2.COLOR_BGR2RGB)


def write_empty_blob():
    os.makedirs(DEMO_DIR, exist_ok=True)
    with open(BLOB_PATH, "wb") as f:
        f.write(b"DMO1" + struct.pack("<HHBB", 0, 0, 30, 0))


def build_blob(paths, width, height, fit="crop", fps=30, max_bytes=None):
    """Convert videos to the blob. Returns dict(clips=[{path, frames}], bytes=int)."""
    import cv2
    os.makedirs(DEMO_DIR, exist_ok=True)
    clips = []
    for p in paths:
        cap = cv2.VideoCapture(p)
        if not cap.isOpened():
            raise RuntimeError(f"動画を開けません: {p}")
        src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        step = src_fps / fps          # source frames per output frame
        frames, idx, nxt = [], 0, 0.0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if idx >= nxt - 1e-6:     # resample to the target fps
                frames.append(fit_frame(frame, width, height, fit).tobytes())
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


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 4:
        print("usage: python demo_builder.py WIDTH HEIGHT video1 [video2 ...]")
        sys.exit(1)
    print(build_blob(sys.argv[3:], int(sys.argv[1]), int(sys.argv[2])))
