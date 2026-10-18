import os
import sys
import uuid
import socket
import subprocess
import serial.tools.list_ports
from flask import Flask, jsonify, request, render_template, Response, stream_with_context, send_file
from flask_cors import CORS
import json
import time
import webbrowser
import threading
import esptool
import io
import base64
import tempfile
import struct
import contextlib
import serial as pyserial
import demo_builder
from demo_builder import fit_frame

# Determine base paths
if getattr(sys, 'frozen', False):
    BASE_DIR = sys._MEIPASS
    template_folder = os.path.join(BASE_DIR, 'templates')
    static_folder = os.path.join(BASE_DIR, 'static')
    app = Flask(__name__, template_folder=template_folder, static_folder=static_folder)
    EXE_DIR = os.path.dirname(sys.executable)
    PROD_PROJECT_DIR = os.path.abspath(os.path.join(EXE_DIR, "..", "AudioLinkLight_Draft", "scripts", "esp32"))
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    app = Flask(__name__)
    PROD_PROJECT_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "AudioLinkLight_Draft", "scripts", "esp32"))

CORS(app)

UPLOAD_DIR = os.path.join(tempfile.gettempdir(), "esp32_tester_uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

video_state = {
    "path": None,
    "thread": None,
    "stop": threading.Event(),
    "playing": False,
    "frame": 0,
    "error": None,
    "source_name": None,
    "latest_rgb_b64": None,
    "width": 36,
    "height": 24
}

serial_lock = threading.Lock()


def get_lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.2)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def load_boards_registry():
    reg_path = os.path.join(BASE_DIR, "boards_registry.json")
    if os.path.exists(reg_path):
        with open(reg_path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"families": [], "led_chips": []}


# ---------------- LED Sheet Preset & Specification Table Management ----------------
SHEETS_REG_PATH = os.path.join(BASE_DIR, "led_sheets_registry.json")
SHEETS_MD_PATH = os.path.join(BASE_DIR, "LED_SHEETS_SPEC.md")


def load_led_sheets():
    if os.path.exists(SHEETS_REG_PATH):
        with open(SHEETS_REG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"sheets": []}


def sync_led_sheets_md(data):
    """Automatically generate/update LED_SHEETS_SPEC.md from led_sheets_registry.json."""
    pos_map = {0: "Top-Left (左上)", 1: "Top-Right (右上)", 2: "Bottom-Left (左下)", 3: "Bottom-Right (右下)"}
    topo_map = {"unified": "統合分割", "independent": "独立ゾーン", "mirror": "ミラー出力"}
    lines = [
        "# 各種 LED シート 仕様管理表 (LED Sheet Specifications)",
        "",
        "> 本ファイルは Web UI の「📋 LEDシート仕様管理表」および `led_sheets_registry.json` と自動同期されます。",
        "",
        "| 型番 / コード | シート名称 | 解像度 (W×H) | 総LED数 | 物理サイズ / ピッチ | LEDチップ (電圧/色順) | データピン構成 (トポロジー) | 配線仕様 (起点 / Zigzag) | 推奨輝度 | 用途・備考 |",
        "|---|---|---:|---:|---|---|---|---|:---:|---|"
    ]
    for s in data.get("sheets", []):
        chs = s.get("channels", [])
        pins_str = ", ".join([f"Ch{i+1}:GPIO{c.get('pin')}({c.get('width')}×{c.get('height')})" for i, c in enumerate(chs)])
        topo_str = topo_map.get(s.get("topology", "unified"), s.get("topology", "unified"))
        zz_str = "Zigzag(蛇行)" if s.get("zigzag", True) else "Straight(順方向)"
        start_str = pos_map.get(int(s.get("start_pos", 0)), "TL")
        lines.append(
            f"| `{s.get('code', '-')}` | **{s.get('name', '')}** | **{s.get('canvas_width')}×{s.get('canvas_height')}** "
            f"| {s.get('total_leds', int(s.get('canvas_width', 1))*int(s.get('canvas_height', 1)))}灯 "
            f"| {s.get('physical_size', '-')} | {s.get('led_chip', 'WS2812B')} ({s.get('voltage', 5)}V / {s.get('color_order', 'GRB')}) "
            f"| {len(chs)}ピン [{topo_str}]<br><small>{pins_str}</small> | {start_str} / {zz_str} "
            f"| {s.get('recommended_brightness', 10)} | {s.get('usage', '-')} |"
        )
    lines.append("")
    try:
        with open(SHEETS_MD_PATH, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
    except Exception as e:
        print(f"Warning: could not write LED_SHEETS_SPEC.md: {e}")


def save_led_sheets(data):
    with open(SHEETS_REG_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    sync_led_sheets_md(data)


# Ensure LED_SHEETS_SPEC.md is generated on startup
sync_led_sheets_md(load_led_sheets())


@app.route('/api/led_sheets', methods=['GET'])
def api_get_led_sheets():
    return jsonify(load_led_sheets())


@app.route('/api/led_sheets', methods=['POST'])
def api_save_led_sheet():
    d = request.json or {}
    reg = load_led_sheets()
    sheets = reg.get("sheets", [])

    sheet_id = d.get("id") or f"sheet_{int(time.time())}_{uuid.uuid4().hex[:4]}"
    cw = max(1, int(d.get("canvas_width", 36)))
    ch = max(1, int(d.get("canvas_height", 24)))
    channels = d.get("channels") or [{"pin": 2, "width": cw, "height": ch, "zigzag": True, "start_pos": 0, "enabled": True}]
    topo = d.get("topology", "unified")
    total_leds = cw * ch * len(channels) if topo == "mirror" else sum(int(c.get("width", cw)) * int(c.get("height", ch)) for c in channels)

    entry = {
        "id": sheet_id,
        "code": d.get("code") or f"CUSTOM-{cw}x{ch}",
        "name": d.get("name") or f"{cw}×{ch} カスタムLEDシート",
        "usage": d.get("usage") or "カスタム登録シート",
        "led_chip": d.get("led_chip", "WS2812B"),
        "voltage": int(d.get("voltage", 5)),
        "color_order": d.get("color_order", "GRB"),
        "canvas_width": cw,
        "canvas_height": ch,
        "total_leds": total_leds,
        "physical_size": d.get("physical_size") or f"{cw*10}mm × {ch*10}mm",
        "topology": topo,
        "zigzag": bool(d.get("zigzag", True)),
        "start_pos": int(d.get("start_pos", 0)),
        "recommended_brightness": int(d.get("recommended_brightness", 10)),
        "channels": channels
    }

    replaced = False
    for idx, s in enumerate(sheets):
        if s.get("id") == sheet_id:
            sheets[idx] = entry
            replaced = True
            break
    if not replaced:
        sheets.insert(0, entry)

    reg["sheets"] = sheets
    save_led_sheets(reg)
    return jsonify({"success": True, "sheet": entry, "sheets": sheets})


@app.route('/api/led_sheets/<sheet_id>', methods=['DELETE'])
def api_delete_led_sheet(sheet_id):
    reg = load_led_sheets()
    reg["sheets"] = [s for s in reg.get("sheets", []) if s.get("id") != sheet_id]
    save_led_sheets(reg)
    return jsonify({"success": True, "sheets": reg["sheets"]})


def get_esp32_ports():
    ports = serial.tools.list_ports.comports()
    results = []
    for port in ports:
        keywords = ["CP210", "CH340", "USB Serial", "ESP32", "JTAG", "CDC", "UART", "Teensy", "SPRESENSE", "SLAB"]
        is_likely = any(kw.lower() in port.description.lower() for kw in keywords)
        vids = [0x303a, 0x10c4, 0x1a86, 0x0403, 0x16c0, 0x054c]
        if port.vid in vids:
            is_likely = True
        results.append({
            "device": port.device,
            "description": port.description,
            "vid": port.vid,
            "pid": port.pid,
            "is_likely": is_likely
        })
    return results


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/boards')
def api_boards():
    return jsonify(load_boards_registry())


@app.route('/api/network_info')
def api_network_info():
    lan_ip = get_lan_ip()
    return jsonify({
        "lan_ip": lan_ip,
        "pc_studio_url": f"http://{lan_ip}:5000",
        "mobile_remote_url": f"http://{lan_ip}:5000/?view=mobile",
        "esp32_ap_url": "http://192.168.4.1"
    })


@app.route('/api/scan')
def api_scan():
    return jsonify(get_esp32_ports())


@app.route('/api/info')
def api_info():
    port = request.args.get('port')
    if not port:
        return jsonify({"error": "No port provided"}), 400
    try:
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            try:
                esptool.main(['--port', port, 'flash_id'])
            except SystemExit as e:
                if e.code != 0:
                    raise RuntimeError(f"esptool exited with code {e.code}")

        stdout_content = output.getvalue()
        detected_size = "4MB"
        chip_type = "Unknown"

        if "Detected flash size:" in stdout_content:
            detected_size = stdout_content.split("Detected flash size:")[1].split("\n")[0].strip()
        if "Chip is" in stdout_content:
            chip_type = stdout_content.split("Chip is")[1].split("\n")[0].strip()

        return jsonify({
            "output": stdout_content,
            "chip": chip_type,
            "size": detected_size
        })
    except Exception as e:
        print(f"Error in info: {e}")
        return jsonify({"error": str(e)}), 500


@app.route('/api/deploy', methods=['POST'])
def api_deploy():
    data = request.json or {}
    port = data.get('port')
    project_type = data.get('project', 'tester')
    board = data.get('board', 'esp32s3')
    flash_size = data.get('flash_size', '4MB')

    cwd = PROD_PROJECT_DIR if project_type == 'prod' else BASE_DIR

    channels = data.get('channels') or []
    topology = data.get('topology', 'unified')
    led_chip = data.get('led_chip', 'WS2812B')

    if channels:
        ch_a = channels[0]
        pin_a = int(ch_a.get('pin', 2))
        width_a = int(ch_a.get('width', 36))
        height_a = int(ch_a.get('height', 24))
        is_dual = len(channels) >= 2
        ch_b = channels[1] if is_dual else {"pin": 4, "width": width_a, "height": height_a}
        pin_b = int(ch_b.get('pin', 4))
        width_b = int(ch_b.get('width', width_a))
        height_b = int(ch_b.get('height', height_a))
    else:
        is_dual = data.get('is_dual', False)
        pin_a = int(data.get('pin_a', 2))
        width_a = int(data.get('width_a', 36))
        height_a = int(data.get('height_a', 24))
        pin_b = int(data.get('pin_b', 4))
        width_b = int(data.get('width_b', 88))
        height_b = int(data.get('height_b', 10))

    canvas_w = int(data.get('canvas_width') or width_a)
    canvas_h = int(data.get('canvas_height') or height_a)

    zigzag = 1 if data.get('zigzag', False) else 0
    start_pos = int(data.get('start_pos', 0))
    test_mode = int(data.get('test_mode', 9))
    order = data.get('order', 'GRB')
    brightness = max(1, min(255, int(data.get('brightness', 10))))

    flags = [
        f"-D LED_ORDER={order}",
        f"-D ZIGZAG={zigzag}",
        f"-D START_POS={start_pos}",
        f"-D TEST_MODE={test_mode}",
        f"-D STRIP_A_PIN={pin_a}",
        f"-D STRIP_A_WIDTH={canvas_w}",
        f"-D STRIP_A_HEIGHT={canvas_h}",
        f"-D LED_BRIGHTNESS={brightness}",
        f"-D ACTIVE_CH_COUNT={max(1, min(8, len(channels) or (2 if is_dual else 1)))}"
    ]

    for idx, ch in enumerate(channels[:8]):
        ch_num = idx + 1
        flags.append(f"-D CH{ch_num}_PIN={int(ch.get('pin', 2))}")
        flags.append(f"-D CH{ch_num}_WIDTH={int(ch.get('width', 36))}")
        flags.append(f"-D CH{ch_num}_HEIGHT={int(ch.get('height', 24))}")
        flags.append(f"-D CH{ch_num}_ZIGZAG={1 if ch.get('zigzag', zigzag) else 0}")
        flags.append(f"-D CH{ch_num}_START_POS={int(ch.get('start_pos', start_pos))}")

    env = os.environ.copy()
    demo_max_bytes = None

    if 's3' in str(board).lower():
        flags.append("-D ARDUINO_USB_CDC_ON_BOOT=1")
        flags.append("-D ARDUINO_USB_MODE=1")
        flags.append("-D ESP32S3")
        env["PLATFORMIO_BOARD_BUILD_FLASH_SIZE"] = flash_size
        if project_type == 'prod':
            env["PLATFORMIO_BOARD_BUILD_PARTITIONS"] = "default.csv" if flash_size == "4MB" else "default_8MB.csv"
        else:
            env["PLATFORMIO_BOARD_BUILD_PARTITIONS"] = "partitions_4MB_demo.csv" if flash_size == "4MB" else "partitions_8MB_demo.csv"
            demo_max_bytes = 0x3E0000 - 600 * 1024 if flash_size == "4MB" else 0x7E0000 - 600 * 1024
    else:
        flags.append("-D ESP32_GENERIC")

    demo_paths = [p.strip().strip('"') for p in (data.get('demo_clips') or []) if p.strip()]
    demo_fit = data.get('demo_fit', 'crop')
    flags.append(f"-D DEMO_FADE_MS={int(data.get('demo_fade_ms', 800))}")

    if is_dual:
        flags.append("-D DUAL_OUTPUT")
        flags.append(f"-D STRIP_B_PIN={pin_b}")
        flags.append(f"-D STRIP_B_WIDTH={width_b}")
        flags.append(f"-D STRIP_B_HEIGHT={height_b}")

    env["PLATFORMIO_BUILD_FLAGS"] = " ".join(flags)
    env["PYTHONIOENCODING"] = "utf-8"

    pio_cmd = "pio"
    possible_pio = os.path.join(os.path.expanduser("~"), ".platformio", "penv", "Scripts", "pio.exe")
    if os.path.exists(possible_pio):
        pio_cmd = possible_pio

    def generate():
        try:
            if project_type != 'prod':
                if demo_paths:
                    yield json.dumps({"type": "log", "content": f"Converting {len(demo_paths)} clip(s) to {canvas_w}x{canvas_h} ({demo_fit}, 30fps)..."}) + "\n"
                    info = demo_builder.build_blob(demo_paths, int(canvas_w), int(canvas_h), demo_fit, 30, demo_max_bytes)
                    for c in info["clips"]:
                        yield json.dumps({"type": "log", "content": f"  {os.path.basename(c['path'])}: {c['frames']} frames"}) + "\n"
                    yield json.dumps({"type": "log", "content": f"Demo clip data: {info['bytes']/1e6:.2f}MB"}) + "\n"
                else:
                    demo_builder.write_empty_blob()
            pio_env = board
            if project_type != 'prod' and board == 'esp32s3':
                pio_env = 'esp32s3_4mb' if flash_size == '4MB' else 'esp32s3_8mb'
                yield json.dumps({"type": "log", "content": f"Using env {pio_env} (flash {flash_size}, LED Chip: {led_chip}, Topology: {topology})"}) + "\n"
            cmd = [pio_cmd, "run", "-e", pio_env, "--target", "upload", "--upload-port", port]
            process = subprocess.Popen(
                cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding='utf-8', errors='replace', bufsize=1,
                cwd=cwd
            )
            for line in process.stdout:
                yield json.dumps({"type": "log", "content": line.strip()}) + "\n"

            process.wait()
            success = process.returncode == 0
            yield json.dumps({"type": "status", "success": success}) + "\n"
        except FileNotFoundError:
            yield json.dumps({"type": "error", "content": "PlatformIO Core (pio) が見つかりませんでした。"}) + "\n"
        except Exception as e:
            print(f"Error in deploy: {e}")
            yield json.dumps({"type": "error", "content": str(e)}) + "\n"

    return Response(stream_with_context(generate()), mimetype='application/x-ndjson')


@app.route('/api/clean', methods=['POST'])
def api_clean():
    data = request.json or {}
    project_type = data.get('project', 'tester')
    board = data.get('board', 'esp32s3')
    cwd = PROD_PROJECT_DIR if project_type == 'prod' else BASE_DIR

    pio_cmd = "pio"
    possible_pio = os.path.join(os.path.expanduser("~"), ".platformio", "penv", "Scripts", "pio.exe")
    if os.path.exists(possible_pio):
        pio_cmd = possible_pio

    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"

    try:
        result = subprocess.run(
            [pio_cmd, "run", "-e", board, "--target", "clean"],
            env=env, capture_output=True, text=True,
            encoding='utf-8', errors='replace',
            cwd=cwd
        )
        return jsonify({"success": result.returncode == 0, "output": result.stdout})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ---------------- Content (video) & Media Converter Studio ----------------

def build_packet(rgb_bytes, w, h):
    chk = 0
    for b in rgb_bytes:
        chk ^= b
    return b"\xAA\x55" + struct.pack(">HH", int(w), int(h)) + rgb_bytes + bytes([chk])


def build_control_packet(cmd_id, payload_bytes=b""):
    body = bytes([cmd_id]) + struct.pack(">H", len(payload_bytes)) + payload_bytes
    chk = 0
    for b in body:
        chk ^= b
    return b"\xAA\x56" + body + bytes([chk])


@app.route('/api/video/upload', methods=['POST'])
def api_video_upload():
    f = request.files.get('file')
    if not f:
        return jsonify({"error": "No file"}), 400
    ext = os.path.splitext(f.filename)[1] or ".mp4"
    orig_name = os.path.splitext(f.filename)[0]
    path = os.path.join(UPLOAD_DIR, "current" + ext)
    f.save(path)
    import cv2
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        return jsonify({"error": "動画を開けませんでした"}), 400
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    info = {
        "name": orig_name,
        "fps": fps,
        "frames": frames,
        "duration": round(frames / fps, 2) if fps > 0 else 0,
        "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
        "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    }
    cap.release()
    video_state["path"] = path
    video_state["source_name"] = orig_name
    return jsonify(info)


@app.route('/api/video/preview', methods=['POST'])
def api_video_preview():
    import cv2
    d = request.json or {}
    src_path = d.get('local_path') or video_state.get("path")
    if not src_path or not os.path.exists(src_path):
        return jsonify({"error": "動画が選択されていません"}), 400

    w = max(1, min(256, int(d.get('width', 36))))
    h = max(1, min(256, int(d.get('height', 24))))
    gamma = float(d.get('gamma', 1.0))
    contrast = float(d.get('contrast', 1.0))
    saturation = float(d.get('saturation', 1.0))
    black_cutoff = int(d.get('black_cutoff', 0))
    offset_x = float(d.get('offset_x', 0.0))
    offset_y = float(d.get('offset_y', 0.0))
    zoom = float(d.get('zoom', 1.0))

    cap = cv2.VideoCapture(src_path)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    pos_frame = min(max(0, total - 1), int(total * float(d.get('pos', 0))))
    cap.set(cv2.CAP_PROP_POS_FRAMES, pos_frame)
    ok, frame = cap.read()
    cap.release()
    if not ok:
        return jsonify({"error": "フレーム取得失敗"}), 400

    rgb = fit_frame(
        frame, w, h, d.get('fit', 'crop'),
        gamma=gamma, contrast=contrast, saturation=saturation,
        black_cutoff=black_cutoff, offset_x=offset_x, offset_y=offset_y, zoom=zoom
    )
    scale = max(1, min(16, 640 // w))
    big = cv2.resize(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), (w * scale, h * scale), interpolation=cv2.INTER_NEAREST)
    _, png = cv2.imencode('.png', big)
    raw_b64 = base64.b64encode(rgb.tobytes()).decode()
    return jsonify({
        "image": "data:image/png;base64," + base64.b64encode(png.tobytes()).decode(),
        "raw_rgb": raw_b64,
        "width": w,
        "height": h
    })


# ---------------- LED Source Library APIs ----------------

@app.route('/api/library', methods=['GET'])
def api_library_list():
    return jsonify(demo_builder.list_library())


@app.route('/api/library/convert', methods=['POST'])
def api_library_convert():
    d = request.json or {}
    src_path = d.get('local_path') or video_state.get("path")
    if not src_path or not os.path.exists(src_path):
        return jsonify({"error": "変換元の動画が選択されていません"}), 400
    try:
        meta = demo_builder.convert_to_library(
            src_path=src_path,
            title=d.get('title') or video_state.get("source_name") or "Converted Clip",
            width=int(d.get('width', 36)),
            height=int(d.get('height', 24)),
            fit=d.get('fit', 'crop'),
            fps=int(d.get('fps') or 30),
            gamma=float(d.get('gamma', 2.2)),
            contrast=float(d.get('contrast', 1.0)),
            saturation=float(d.get('saturation', 1.0)),
            black_cutoff=int(d.get('black_cutoff', 5)),
            offset_x=float(d.get('offset_x', 0.0)),
            offset_y=float(d.get('offset_y', 0.0)),
            zoom=float(d.get('zoom', 1.0)),
            trim_start=float(d.get('trim_start', 0.0)),
            trim_end=float(d.get('trim_end', 0.0))
        )
        return jsonify({"success": True, "item": meta})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/library/save_raw', methods=['POST'])
def api_library_save_raw():
    d = request.json or {}
    frames_b64 = d.get('frames', [])
    w = int(d.get('width', 36))
    h = int(d.get('height', 24))
    fps = int(d.get('fps', 30))
    title = d.get('title', 'Custom Art')
    try:
        raw_frames = [base64.b64decode(fb) for fb in frames_b64]
        meta = demo_builder.save_raw_frames_to_library(raw_frames, w, h, fps=fps, title=title)
        return jsonify({"success": True, "item": meta})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/library/frames/<item_id>', methods=['GET'])
def api_library_frames(item_id):
    bin_path = os.path.join(demo_builder.LIBRARY_DIR, f"{item_id}.ledbin")
    if not os.path.exists(bin_path):
        return jsonify({"error": "Not found"}), 404
    try:
        lb = demo_builder.read_ledbin(bin_path)
        return jsonify({
            "id": item_id,
            "width": lb["width"],
            "height": lb["height"],
            "fps": lb["fps"],
            "frames": [base64.b64encode(f).decode() for f in lb["frames"]]
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/library/download/<item_id>', methods=['GET'])
def api_library_download(item_id):
    bin_path = os.path.join(demo_builder.LIBRARY_DIR, f"{item_id}.ledbin")
    if not os.path.exists(bin_path):
        return jsonify({"error": "Not found"}), 404
    return send_file(bin_path, as_attachment=True, download_name=f"{item_id}.ledbin")


@app.route('/api/library/delete/<item_id>', methods=['DELETE'])
def api_library_delete(item_id):
    for ext in [".ledbin", ".json"]:
        p = os.path.join(demo_builder.LIBRARY_DIR, f"{item_id}{ext}")
        if os.path.exists(p):
            os.remove(p)
    return jsonify({"success": True})


# ---------------- Streaming & Live Control Workers ----------------

def _send_worker(port, w, h, fit, loop, fps_override, gamma=1.0, contrast=1.0, saturation=1.0,
                 black_cutoff=0, offset_x=0.0, offset_y=0.0, zoom=1.0, ledbin_path=None):
    import cv2
    st = video_state
    st.update(playing=True, frame=0, error=None, width=w, height=h)
    ser = None
    try:
        if port:
            ser = pyserial.Serial(port, 921600, timeout=1, write_timeout=2)

        if ledbin_path and os.path.exists(ledbin_path):
            lb = demo_builder.read_ledbin(ledbin_path)
            fps = fps_override or lb["fps"] or 30.0
            fps = max(1.0, min(60.0, float(fps)))
            interval = 1.0 / fps
            nxt = time.time()
            frames = lb["frames"]
            fw, fh = lb["width"], lb["height"]
            idx = 0
            while not st["stop"].is_set() and frames:
                raw_bytes = frames[idx]
                st["latest_rgb_b64"] = base64.b64encode(raw_bytes).decode()
                if ser:
                    ser.write(build_packet(raw_bytes, fw, fh))
                st["frame"] += 1
                idx += 1
                if idx >= len(frames):
                    if loop:
                        idx = 0
                    else:
                        break
                nxt += interval
                delay = nxt - time.time()
                if delay > 0:
                    time.sleep(delay)
                else:
                    nxt = time.time()
        else:
            cap = cv2.VideoCapture(st["path"])
            fps = fps_override or cap.get(cv2.CAP_PROP_FPS) or 30.0
            fps = max(1.0, min(60.0, float(fps)))
            interval = 1.0 / fps
            nxt = time.time()
            while not st["stop"].is_set():
                ok, frame = cap.read()
                if not ok:
                    if loop:
                        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                        continue
                    break
                rgb = fit_frame(
                    frame, w, h, fit,
                    gamma=gamma, contrast=contrast, saturation=saturation,
                    black_cutoff=black_cutoff, offset_x=offset_x, offset_y=offset_y, zoom=zoom
                )
                raw_bytes = rgb.tobytes()
                st["latest_rgb_b64"] = base64.b64encode(raw_bytes).decode()
                if ser:
                    ser.write(build_packet(raw_bytes, w, h))
                st["frame"] += 1
                nxt += interval
                delay = nxt - time.time()
                if delay > 0:
                    time.sleep(delay)
                else:
                    nxt = time.time()
            cap.release()
    except Exception as e:
        st["error"] = str(e)
    finally:
        if ser:
            ser.close()
        st["playing"] = False


@app.route('/api/video/send', methods=['POST'])
def api_video_send():
    d = request.json or {}
    if video_state["playing"]:
        video_state["stop"].set()
        time.sleep(0.1)

    library_id = d.get('library_id')
    ledbin_path = None
    if library_id:
        ledbin_path = os.path.join(demo_builder.LIBRARY_DIR, f"{library_id}.ledbin")
        if not os.path.exists(ledbin_path):
            return jsonify({"error": "指定されたライブラリアイテムが見つかりません"}), 404
    elif not video_state["path"]:
        return jsonify({"error": "動画が選択されていません"}), 400

    port = d.get('port')
    video_state["stop"] = threading.Event()
    t = threading.Thread(target=_send_worker, daemon=True, args=(
        port,
        int(d.get('width', 36)),
        int(d.get('height', 24)),
        d.get('fit', 'crop'),
        bool(d.get('loop', True)),
        float(d.get('fps') or 0),
        float(d.get('gamma', 1.0)),
        float(d.get('contrast', 1.0)),
        float(d.get('saturation', 1.0)),
        int(d.get('black_cutoff', 0)),
        float(d.get('offset_x', 0.0)),
        float(d.get('offset_y', 0.0)),
        float(d.get('zoom', 1.0)),
        ledbin_path
    ))
    video_state["thread"] = t
    video_state["playing"] = True
    t.start()
    return jsonify({"success": True})


@app.route('/api/video/stop', methods=['POST'])
def api_video_stop():
    video_state["stop"].set()
    return jsonify({"success": True})


@app.route('/api/video/status')
def api_video_status():
    return jsonify({
        "playing": video_state["playing"],
        "frame": video_state["frame"],
        "error": video_state["error"],
        "width": video_state["width"],
        "height": video_state["height"],
        "latest_rgb": video_state["latest_rgb_b64"]
    })


@app.route('/api/live/frame', methods=['POST'])
def api_live_frame():
    d = request.json or {}
    port = d.get('port')
    raw_b64 = d.get('raw_rgb')
    w = int(d.get('width', 36))
    h = int(d.get('height', 24))
    if not raw_b64:
        return jsonify({"error": "No frame data"}), 400
    raw_bytes = base64.b64decode(raw_b64)
    video_state["latest_rgb_b64"] = raw_b64
    video_state["width"] = w
    video_state["height"] = h
    if not port:
        return jsonify({"success": True, "simulated_only": True})
    try:
        with serial_lock:
            with pyserial.Serial(port, 921600, timeout=0.5, write_timeout=1) as ser:
                ser.write(build_packet(raw_bytes, w, h))
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/live/control', methods=['POST'])
def api_live_control():
    d = request.json or {}
    port = d.get('port')
    cmd_type = d.get('cmd')
    if not port:
        return jsonify({"success": True, "simulated_only": True, "note": "Port not selected; updated UI state only"})

    cmd_map = {
        "brightness": (0x01, bytes([max(1, min(255, int(d.get('value', 10))))])),
        "mode": (0x02, bytes([int(d.get('value', 0))])),
        "clip": (0x03, bytes([int(d.get('value', 0))])),
        "test_mode": (0x04, bytes([int(d.get('value', 9))])),
        "color_fx": (0x05, bytes([
            int(d.get('effect', 0)),
            int(d.get('r', 0)),
            int(d.get('g', 242)),
            int(d.get('b', 255)),
            int(d.get('speed', 128)),
            int(d.get('ch_mask', 0xFF))
        ]))
    }
    if cmd_type not in cmd_map:
        return jsonify({"error": f"Unknown command: {cmd_type}"}), 400

    cmd_id, payload = cmd_map[cmd_type]
    pkt = build_control_packet(cmd_id, payload)
    try:
        with serial_lock:
            with pyserial.Serial(port, 921600, timeout=0.5, write_timeout=1) as ser:
                ser.write(pkt)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def open_browser():
    time.sleep(1.5)
    webbrowser.open("http://127.0.0.1:5000")


if __name__ == "__main__":
    if not getattr(sys, 'frozen', False):
        os.makedirs('templates', exist_ok=True)
        os.makedirs('static', exist_ok=True)

    lan_ip = get_lan_ip()
    print(f"Server starting at http://127.0.0.1:5000 (LAN / Smartphone: http://{lan_ip}:5000/?view=mobile)")

    threading.Thread(target=open_browser, daemon=True).start()

    is_debug = not getattr(sys, 'frozen', False)
    app.run(host='0.0.0.0', debug=is_debug, port=5000)
