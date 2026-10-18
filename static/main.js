document.addEventListener('DOMContentLoaded', () => {
    const portSelect = document.getElementById('port-select');
    const scanBtn = document.getElementById('scan-btn');
    const infoBtn = document.getElementById('info-btn');
    const deployBtn = document.getElementById('deploy-btn');
    const infoBox = document.getElementById('chip-info');
    const consoleBox = document.getElementById('console');
    const dualModeToggle = document.getElementById('dual-mode-toggle');
    const stripB = document.getElementById('strip-b');
    const projectSelect = document.getElementById('project-select');
    const boardSelect = document.getElementById('board-select');
    const brightnessSlider = document.getElementById('brightness-slider');
    const brightnessValueDisplay = document.getElementById('brightness-value');
    const brightnessWarning = document.getElementById('brightness-warning');
    const brightnessConsent = document.getElementById('brightness-consent');

    const projectEnvs = {
        tester: [
            { value: 'esp32s3', label: 'esp32s3 (Tester Default)' },
            { value: 'esp32', label: 'esp32 (Generic)' }
        ],
        prod: [
            { value: 'master_4mb', label: 'master_4mb (Serial 4MB)' },
            { value: 'master_8mb', label: 'master_8mb (Serial 8MB)' },
            { value: 'slave_8mb', label: 'slave_8mb (WiFi/UDP 8MB)' }
        ]
    };

    function updateEnvs() {
        const project = projectSelect.value;
        const envs = projectEnvs[project] || [];
        boardSelect.innerHTML = envs.map(env => `<option value="${env.value}">${env.label}</option>`).join('');
    }

    projectSelect.addEventListener('change', updateEnvs);
    updateEnvs();

    // Toggle Dual Mode UI
    dualModeToggle.addEventListener('change', () => {
        if (dualModeToggle.checked) {
            stripB.classList.remove('disabled');
        } else {
            stripB.classList.add('disabled');
        }
    });

    // Brightness slider logic
    function updateBrightness() {
        const val = parseInt(brightnessSlider.value);
        brightnessValueDisplay.textContent = val;

        // Update slider track color based on danger level
        const pct = ((val - 1) / 254) * 100;
        if (val <= 10) {
            brightnessSlider.style.setProperty('--track-fill', `hsl(160, 70%, 50%)`);
        } else if (val <= 50) {
            brightnessSlider.style.setProperty('--track-fill', `hsl(40, 100%, 55%)`);
        } else {
            brightnessSlider.style.setProperty('--track-fill', `hsl(0, 85%, 55%)`);
        }

        // Show/hide warning
        if (val > 10) {
            brightnessWarning.classList.remove('hidden');
            brightnessConsent.checked = false; // Reset consent on every change above 10
        } else {
            brightnessWarning.classList.add('hidden');
            brightnessConsent.checked = false;
        }
    }

    brightnessSlider.addEventListener('input', updateBrightness);
    updateBrightness(); // Initialize on load

    // Logging helper
    function log(message, type = 'dim') {
        const line = document.createElement('div');
        line.className = `line ${type}`;
        line.textContent = `> ${message}`;
        consoleBox.appendChild(line);
        consoleBox.parentElement.scrollTop = consoleBox.parentElement.scrollHeight;
    }

    // Scan for ports
    async function scanPorts() {
        log('Scanning for devices...', 'system');
        scanBtn.disabled = true;
        try {
            const response = await fetch('/api/scan');
            const data = await response.json();
            
            portSelect.innerHTML = '<option value="">Select a device...</option>';
            data.forEach(item => {
                const opt = document.createElement('option');
                opt.value = item.device;
                opt.textContent = `${item.device} - ${item.description} ${item.is_likely ? '✨' : ''}`;
                portSelect.appendChild(opt);
            });
            
            log(`Found ${data.length} devices.`);
        } catch (err) {
            log(`Scan failed: ${err.message}`, 'error');
        }
        scanBtn.disabled = false;
    }

    let detectedChipInfo = { chip: null, size: "4MB" };

    // Get chip info
    async function getInfo() {
        const port = portSelect.value;
        if (!port) return;
        
        log(`Querying chip info for ${port}...`, 'system');
        infoBtn.disabled = true;
        infoBox.classList.add('hidden');
        document.getElementById('chip-status').classList.add('hidden');
        
        try {
            const response = await fetch(`/api/info?port=${encodeURIComponent(port)}`);
            const data = await response.json();
            
            if (data.error) {
                log(`Error: ${data.error}`, 'error');
            } else {
                infoBox.textContent = data.output;
                infoBox.classList.remove('hidden');
                
                // Update badges
                detectedChipInfo.chip = data.chip;
                detectedChipInfo.size = data.size;
                
                document.getElementById('chip-badge').textContent = data.chip;
                document.getElementById('size-badge').textContent = data.size;
                document.getElementById('chip-status').classList.remove('hidden');
                
                log(`Chip identified: ${data.chip} (${data.size})`, 'success');
            }
        } catch (err) {
            log(`Request failed: ${err.message}`, 'error');
        }
        infoBtn.disabled = false;
    }

    // Deploy firmware
    async function deploy() {
        const port = portSelect.value;
        if (!port) {
            alert('Please select a port first.');
            return;
        }

        const config = {
            port: port,
            project: projectSelect.value,
            board: boardSelect.value,
            flash_size: detectedChipInfo.size,
            is_dual: dualModeToggle.checked,
            pin_a: document.getElementById('pin-a').value,
            width_a: document.getElementById('width-a').value,
            height_a: document.getElementById('height-a').value,
            pin_b: document.getElementById('pin-b').value,
            width_b: document.getElementById('width-b').value,
            height_b: document.getElementById('height-b').value,
            zigzag: document.getElementById('zigzag-toggle').checked,
            start_pos: parseInt(document.getElementById('start-pos').value),
            test_mode: parseInt(document.getElementById('test-mode').value),
            brightness: parseInt(brightnessSlider.value),
            demo_clips: document.getElementById('demo-clips').value.split('\n').map(s => s.trim()).filter(Boolean),
            demo_fit: document.getElementById('demo-fit').value,
            demo_fade_ms: parseInt(document.getElementById('demo-fade').value) || 0,
            order: 'GRB'
        };

        // Safety guard: block deploy if brightness > 10 and no consent
        if (config.brightness > 10 && !brightnessConsent.checked) {
            log('⚠️ 輝度が10を超えています。電流量注意の警告に同意してからデプロイしてください。', 'error');
            log('  ➡ Scroll down to "LED Brightness" and check the consent box.', 'error');
            deployBtn.disabled = false;
            return;
        }

        log('Starting deployment...', 'system');
        log(`Board: ${config.board}, Mode: ${config.test_mode}`, 'dim');
        deployBtn.disabled = true;
        
        try {
            const response = await fetch('/api/deploy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let partial = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                partial += decoder.decode(value, { stream: true });
                const lines = partial.split('\n');
                partial = lines.pop();

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const data = JSON.parse(line);
                        if (data.type === 'log') {
                            log(data.content, 'dim');
                        } else if (data.type === 'status') {
                            if (data.success) {
                                log('DEPLOYMENT SUCCESSFUL!', 'success');
                            } else {
                                log('DEPLOYMENT FAILED. Try "Clean PIO" if errors persist.', 'error');
                            }
                        } else if (data.type === 'error') {
                            log(`Error: ${data.content}`, 'error');
                        }
                    } catch (e) {
                        console.error('Error parsing JSON stream:', e);
                    }
                }
            }
        } catch (err) {
            log(`Request error: ${err.message}`, 'error');
        }
        deployBtn.disabled = false;
    }

    async function clean() {
        const board = boardSelect.value;
        const project = projectSelect.value;
        log(`Cleaning environment for ${board} in ${project}...`, 'system');
        try {
            const resp = await fetch('/api/clean', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ board, project })
            });
            const data = await resp.json();
            if (data.success) {
                log('Clean successful.', 'success');
            } else {
                log(`Clean failed: ${data.error || data.output}`, 'error');
            }
        } catch (err) {
            log(`Error: ${err.message}`, 'error');
        }
    }

    // Event listeners
    scanBtn.addEventListener('click', scanPorts);
    infoBtn.addEventListener('click', getInfo);
    deployBtn.addEventListener('click', deploy);
    document.getElementById('clean-btn').addEventListener('click', clean);
    
    portSelect.addEventListener('change', () => {
        infoBtn.disabled = !portSelect.value;
        if (portSelect.value) {
            document.getElementById('status-badge').textContent = 'Device Selected';
            document.getElementById('status-badge').className = 'badge active';
        }
    });

    // ---------- Content playback ----------
    const vFile = document.getElementById('video-file');
    const vW = document.getElementById('video-width');
    const vH = document.getElementById('video-height');
    const vFps = document.getElementById('video-fps');
    const vFit = document.getElementById('video-fit');
    const vLoop = document.getElementById('video-loop');
    const vPos = document.getElementById('video-pos');
    const vPreviewBtn = document.getElementById('video-preview-btn');
    const vPreview = document.getElementById('video-preview');
    const vOk = document.getElementById('video-ok');
    const vSendBtn = document.getElementById('video-send-btn');
    const vStopBtn = document.getElementById('video-stop-btn');
    const vStatus = document.getElementById('video-status');
    let videoLoaded = false;
    let statusTimer = null;

    // Default content size follows Channel A LED size (firmware only accepts matching size)
    function syncVideoSize() {
        vW.value = document.getElementById('width-a').value;
        vH.value = document.getElementById('height-a').value;
    }
    document.getElementById('width-a').addEventListener('input', syncVideoSize);
    document.getElementById('height-a').addEventListener('input', syncVideoSize);
    syncVideoSize();

    function updateSendState() {
        vSendBtn.disabled = !(videoLoaded && vOk.checked && portSelect.value);
    }
    function invalidatePreview() {
        vOk.checked = false;
        updateSendState();
    }
    [vW, vH, vFit].forEach(el => el.addEventListener('change', () => { invalidatePreview(); if (videoLoaded) preview(); }));
    vPos.addEventListener('change', () => { invalidatePreview(); if (videoLoaded) preview(); });
    vOk.addEventListener('change', updateSendState);
    portSelect.addEventListener('change', updateSendState);

    vFile.addEventListener('change', async () => {
        const file = vFile.files[0];
        if (!file) return;
        log(`Uploading video: ${file.name}`, 'system');
        const fd = new FormData();
        fd.append('file', file);
        try {
            const r = await fetch('/api/video/upload', { method: 'POST', body: fd });
            const d = await r.json();
            if (d.error) { log(`Error: ${d.error}`, 'error'); videoLoaded = false; return; }
            videoLoaded = true;
            document.getElementById('video-meta').textContent =
                `${d.width}x${d.height}, ${d.fps.toFixed(1)}fps, ${d.frames} frames`;
            vPreviewBtn.disabled = false;
            invalidatePreview();
            preview();
        } catch (e) { log(`Upload failed: ${e.message}`, 'error'); }
    });

    async function preview() {
        const r = await fetch('/api/video/preview', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ width: +vW.value, height: +vH.value, fit: vFit.value, pos: vPos.value / 100 })
        });
        const d = await r.json();
        if (d.error) { log(`Error: ${d.error}`, 'error'); return; }
        vPreview.src = d.image;
        vPreview.classList.remove('hidden');
    }
    vPreviewBtn.addEventListener('click', () => { invalidatePreview(); preview(); });

    async function sendVideo() {
        const r = await fetch('/api/video/send', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                port: portSelect.value, width: +vW.value, height: +vH.value,
                fit: vFit.value, loop: vLoop.checked, fps: +vFps.value
            })
        });
        const d = await r.json();
        if (d.error) { log(`Error: ${d.error}`, 'error'); return; }
        log('Content sending started → CONTENT mode', 'success');
        vStopBtn.disabled = false; vSendBtn.disabled = true;
        statusTimer = setInterval(pollStatus, 500);
    }
    async function pollStatus() {
        const d = await (await fetch('/api/video/status')).json();
        if (d.playing) {
            vStatus.textContent = `CONTENT (frame ${d.frame})`;
        } else {
            clearInterval(statusTimer);
            vStatus.textContent = 'DEMO';
            vStopBtn.disabled = true;
            vOk.checked = false;
            updateSendState();
            if (d.error) log(`Send error: ${d.error}`, 'error');
            else log('Sending finished. Device returns to DEMO in ~2s.', 'system');
        }
    }
    vSendBtn.addEventListener('click', sendVideo);
    vStopBtn.addEventListener('click', () => fetch('/api/video/stop', { method: 'POST' }));

    // Initial scan
    scanPorts();
});
