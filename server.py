import os
import sys
import subprocess
import serial.tools.list_ports
from flask import Flask, jsonify, request, render_template, Response, stream_with_context
from flask_cors import CORS
import json
import time
import webbrowser
import threading
import esptool
import io
import demo_builder
from demo_builder import fit_frame
import contextlib

# Determine base paths
if getattr(sys, 'frozen', False):
    # PyInstaller environment
    BASE_DIR = sys._MEIPASS
    template_folder = os.path.join(BASE_DIR, 'templates')
    static_folder = os.path.join(BASE_DIR, 'static')
    app = Flask(__name__, template_folder=template_folder, static_folder=static_folder)
    
    # When frozen, PROD_PROJECT_DIR is resolved relative to the executable's directory
    EXE_DIR = os.path.dirname(sys.executable)
    PROD_PROJECT_DIR = os.path.abspath(os.path.join(EXE_DIR, "..", "AudioLinkLight_Draft", "scripts", "esp32"))
else:
    # Development environment
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    app = Flask(__name__)
    PROD_PROJECT_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "AudioLinkLight_Draft", "scripts", "esp32"))

CORS(app)

def get_esp32_ports():
    ports = serial.tools.list_ports.comports()
    results = []
    for port in ports:
        keywords = ["CP210", "CH340", "USB Serial", "ESP32", "JTAG", "CDC", "UART"]
        is_likely = any(kw.lower() in port.description.lower() for kw in keywords)
        vids = [0x303a, 0x10c4, 0x1a86, 0x0403]
        if port.vid in vids:
            is_likely = True
        results.append({
            "device": port.device,
            "description": port.description,
            "is_likely": is_likely
        })
    return results

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/scan')
def api_scan():
    return jsonify(get_esp32_ports())

@app.route('/api/info')
def api_info():
    port = request.args.get('port')
    if not port:
        return jsonify({"error": "No port provided"}), 400
    try:
        # Use python-based esptool execution directly instead of subprocess
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            try:
                esptool.main(['--port', port, 'flash_id'])
            except SystemExit as e:
                # esptool may call sys.exit(0) on success
                if e.code != 0:
                    raise RuntimeError(f"esptool exited with code {e.code}")
        
        stdout_content = output.getvalue()
        detected_size = "4MB" # Default safe
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
    data = request.json
    port = data.get('port')
    project_type = data.get('project', 'tester') 
    board = data.get('board', 'esp32s3')
    flash_size = data.get('flash_size', '4MB')
    
    # プロジェクトに応じてCWDを切り替え
    cwd = PROD_PROJECT_DIR if project_type == 'prod' else BASE_DIR
    
    is_dual = data.get('is_dual', False)
    
    # Strip A
    pin_a = data.get('pin_a', 2)
    width_a = data.get('width_a', 88)
    height_a = data.get('height_a', 10)
    
    # Strip B
    pin_b = data.get('pin_b', 4)
    width_b = data.get('width_b', 88)
    height_b = data.get('height_b', 10)
    
    zigzag = 1 if data.get('zigzag', False) else 0
    start_pos = data.get('start_pos', 0)
    test_mode = data.get('test_mode', 9)
    order = data.get('order', 'GRB')
    brightness = int(data.get('brightness', 10))
    brightness = max(1, min(255, brightness))  # Clamp to valid range
    
    # Base flags
    flags = [
        f"-D LED_ORDER={order}",
        f"-D ZIGZAG={zigzag}",
        f"-D START_POS={start_pos}",
        f"-D TEST_MODE={test_mode}",
        f"-D STRIP_A_PIN={pin_a}",
        f"-D STRIP_A_WIDTH={width_a}",
        f"-D STRIP_A_HEIGHT={height_a}",
        f"-D LED_BRIGHTNESS={brightness}"
    ]
    
    # Add board-specific flags
    env = os.environ.copy()
    demo_max_bytes = None
    
    if 's3' in str(board).lower():
        flags.append("-D ARDUINO_USB_CDC_ON_BOOT=1")
        flags.append("-D ARDUINO_USB_MODE=1")
        flags.append("-D ESP32S3")
        # Dynamic Flash Size adjustment
        env["PLATFORMIO_BOARD_BUILD_FLASH_SIZE"] = flash_size
        if project_type == 'prod':
            env["PLATFORMIO_BOARD_BUILD_PARTITIONS"] = "default.csv" if flash_size == "4MB" else "default_8MB.csv"
        else:
            # Single large app partition (USB flashing only) leaves room for embedded demo clips
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

    # Try to find pio executable if not in PATH
    pio_cmd = "pio"
    possible_pio = os.path.join(os.path.expanduser("~"), ".platformio", "penv", "Scripts", "pio.exe")
    if os.path.exists(possible_pio):
        pio_cmd = possible_pio

    def generate():
        try:
            if project_type != 'prod':
                if demo_paths:
                    yield json.dumps({"type": "log", "content": f"Converting {len(demo_paths)} demo clip(s) to {width_a}x{height_a} ({demo_fit}, 30fps)..."}) + "\n"
                    info = demo_builder.build_blob(demo_paths, int(width_a), int(height_a), demo_fit, 30, demo_max_bytes)
                    for c in info["clips"]:
                        yield json.dumps({"type": "log", "content": f"  {os.path.basename(c['path'])}: {c['frames']} frames"}) + "\n"
                    yield json.dumps({"type": "log", "content": f"Demo clip data: {info['bytes']/1e6:.2f}MB"}) + "\n"
                else:
                    demo_builder.write_empty_blob()
            pio_env = board
            if project_type != 'prod' and board == 'esp32s3':
                pio_env = 'esp32s3_4mb' if flash_size == '4MB' else 'esp32s3_8mb'
                yield json.dumps({"type": "log", "content": f"Using env {pio_env} (flash {flash_size})"}) + "\n"
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
            yield json.dumps({"type": "error", "content": "PlatformIO Core (pio) が見つかりませんでした。PlatformIO がインストールされていること、および環境変数 PATH に追加されていることを確認してください。"}) + "\n"
        except Exception as e:
            print(f"Error in deploy: {e}")
            yield json.dumps({"type": "error", "content": str(e)}) + "\n"

    return Response(stream_with_context(generate()), mimetype='application/x-ndjson')

@app.route('/api/clean', methods=['POST'])
def api_clean():
    data = request.json
    project_type = data.get('project', 'tester')
    board = data.get('board', 'esp32s3')
    cwd = PROD_PROJECT_DIR if project_type == 'prod' else BASE_DIR

    pio_cmd = "pio"
    # ... (omitted paths for brevity, but they stay)
    # [Note: kept as is for finding pio.exe]
    possible_pio = os.path.join(os.path.expanduser("~"), ".platformio", "penv", "Scripts", "pio.exe")
    if os.path.exists(possible_pio): pio_cmd = possible_pio
    
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

# ---------------- Content (video) playback ----------------
import base64
import tempfile
import struct
import serial as pyserial

UPLOAD_DIR = os.path.join(tempfile.gettempdir(), "esp32_tester_uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)
video_state = {"path": None, "thread": None, "stop": threading.Event(),
               "playing": False, "frame": 0, "error": None}

# fit_frame is imported from demo_builder (shared with the demo clip converter)

def build_packet(rgb):
    h, w = rgb.shape[:2]
    payload = rgb.tobytes()
    chk = 0
    for b in payload:
        chk ^= b
    return b"\xAA\x55" + struct.pack(">HH", w, h) + payload + bytes([chk])

@app.route('/api/video/upload', methods=['POST'])
def api_video_upload():
    f = request.files.get('file')
    if not f:
        return jsonify({"error": "No file"}), 400
    ext = os.path.splitext(f.filename)[1] or ".mp4"
    path = os.path.join(UPLOAD_DIR, "current" + ext)
    f.save(path)
    import cv2
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        return jsonify({"error": "動画を開けませんでした"}), 400
    info = {"fps": cap.get(cv2.CAP_PROP_FPS) or 30.0,
            "frames": int(cap.get(cv2.CAP_PROP_FRAME_COUNT)),
            "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
            "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))}
    cap.release()
    video_state["path"] = path
    return jsonify(info)

@app.route('/api/video/preview', methods=['POST'])
def api_video_preview():
    import cv2
    d = request.json
    if not video_state["path"]:
        return jsonify({"error": "動画が選択されていません"}), 400
    w, h = int(d.get('width', 32)), int(d.get('height', 8))
    cap = cv2.VideoCapture(video_state["path"])
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.set(cv2.CAP_PROP_POS_FRAMES, int(total * float(d.get('pos', 0))))
    ok, frame = cap.read()
    cap.release()
    if not ok:
        return jsonify({"error": "フレーム取得失敗"}), 400
    rgb = fit_frame(frame, w, h, d.get('fit', 'crop'))
    scale = max(1, min(16, 640 // w))
    big = cv2.resize(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), (w * scale, h * scale), interpolation=cv2.INTER_NEAREST)
    _, png = cv2.imencode('.png', big)
    return jsonify({"image": "data:image/png;base64," + base64.b64encode(png.tobytes()).decode()})

def _send_worker(port, w, h, fit, loop, fps_override):
    import cv2
    st = video_state
    st.update(playing=True, frame=0, error=None)
    ser = None
    try:
        ser = pyserial.Serial(port, 921600, timeout=1, write_timeout=2)
        cap = cv2.VideoCapture(st["path"])
        fps = fps_override or cap.get(cv2.CAP_PROP_FPS) or 30.0
        fps = max(1.0, min(60.0, fps))
        interval = 1.0 / fps
        nxt = time.time()
        while not st["stop"].is_set():
            ok, frame = cap.read()
            if not ok:
                if loop:
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    continue
                break
            ser.write(build_packet(fit_frame(frame, w, h, fit)))
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
    d = request.json
    if video_state["playing"]:
        return jsonify({"error": "すでに送信中です"}), 400
    if not video_state["path"]:
        return jsonify({"error": "動画が選択されていません"}), 400
    port = d.get('port')
    if not port:
        return jsonify({"error": "ポートが選択されていません"}), 400
    video_state["stop"] = threading.Event()
    t = threading.Thread(target=_send_worker, daemon=True, args=(
        port, int(d.get('width', 32)), int(d.get('height', 8)), d.get('fit', 'crop'),
        bool(d.get('loop', True)), float(d.get('fps') or 0)))
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
    return jsonify({"playing": video_state["playing"], "frame": video_state["frame"],
                    "error": video_state["error"]})

def open_browser():
    # Wait a moment for Flask to initialize
    time.sleep(1.5)
    webbrowser.open("http://127.0.0.1:5000")

if __name__ == "__main__":
    if not getattr(sys, 'frozen', False):
        os.makedirs('templates', exist_ok=True)
        os.makedirs('static', exist_ok=True)
        
    print("Server starting at http://127.0.0.1:5000")
    
    # Automatically open default browser
    threading.Thread(target=open_browser, daemon=True).start()
    
    # In frozen mode, disable debug to prevent auto-reloader spawns and redundant output
    is_debug = not getattr(sys, 'frozen', False)
    app.run(debug=is_debug, port=5000)
