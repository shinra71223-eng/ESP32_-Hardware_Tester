import os
import sys
import subprocess
import serial.tools.list_ports
from flask import Flask, jsonify, request, render_template, Response, stream_with_context
from flask_cors import CORS
import json
import time

app = Flask(__name__)
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
        # Use simple esptool command
        result = subprocess.run(
            [sys.executable, "-m", "esptool", "--port", port, "flash_id"],
            capture_output=True, text=True, check=True
        )
        return jsonify({"output": result.stdout})
    except Exception as e:
        print(f"Error in info: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/deploy', methods=['POST'])
def api_deploy():
    data = request.json
    port = data.get('port')
    board = data.get('board', 'esp32')
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
    
    flags = [
        f"-D LED_ORDER={order}",
        f"-D ZIGZAG={zigzag}",
        f"-D START_POS={start_pos}",
        f"-D TEST_MODE={test_mode}",
        f"-D STRIP_A_PIN={pin_a}",
        f"-D STRIP_A_WIDTH={width_a}",
        f"-D STRIP_A_HEIGHT={height_a}"
    ]
    
    if is_dual:
        flags.append("-D DUAL_OUTPUT")
        flags.append(f"-D STRIP_B_PIN={pin_b}")
        flags.append(f"-D STRIP_B_WIDTH={width_b}")
        flags.append(f"-D STRIP_B_HEIGHT={height_b}")

    env = os.environ.copy()
    env["PLATFORMIO_BUILD_FLAGS"] = " ".join(flags)
    env["PYTHONIOENCODING"] = "utf-8"

    # Try to find pio executable if not in PATH
    pio_cmd = "pio"
    possible_pio = os.path.join(os.path.expanduser("~"), ".platformio", "penv", "Scripts", "pio.exe")
    if os.path.exists(possible_pio):
        pio_cmd = possible_pio

    def generate():
        try:
            cmd = [pio_cmd, "run", "-e", board, "--target", "upload", "--upload-port", port]
            process = subprocess.Popen(
                cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace', bufsize=1
            )
            for line in process.stdout:
                yield json.dumps({"type": "log", "content": line.strip()}) + "\n"
            
            process.wait()
            success = process.returncode == 0
            yield json.dumps({"type": "status", "success": success}) + "\n"
        except Exception as e:
            print(f"Error in deploy: {e}")
            yield json.dumps({"type": "error", "content": str(e)}) + "\n"

    return Response(stream_with_context(generate()), mimetype='application/x-ndjson')

@app.route('/api/clean', methods=['POST'])
def api_clean():
    board = request.json.get('board', 'esp32')
    pio_cmd = "pio"
    possible_pio = os.path.join(os.path.expanduser("~"), ".platformio", "penv", "Scripts", "pio.exe")
    if os.path.exists(possible_pio): pio_cmd = possible_pio
    
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"

    try:
        result = subprocess.run([pio_cmd, "run", "-e", board, "--target", "clean"], env=env, capture_output=True, text=True, encoding='utf-8', errors='replace')
        return jsonify({"success": result.returncode == 0, "output": result.stdout})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    os.makedirs('templates', exist_ok=True)
    os.makedirs('static', exist_ok=True)
    print("Server starting at http://127.0.0.1:5000")
    app.run(debug=True, port=5000)
