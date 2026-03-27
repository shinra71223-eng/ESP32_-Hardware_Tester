document.addEventListener('DOMContentLoaded', () => {
    const portSelect = document.getElementById('port-select');
    const scanBtn = document.getElementById('scan-btn');
    const infoBtn = document.getElementById('info-btn');
    const deployBtn = document.getElementById('deploy-btn');
    const infoBox = document.getElementById('chip-info');
    const consoleBox = document.getElementById('console');
    const dualModeToggle = document.getElementById('dual-mode-toggle');
    const stripB = document.getElementById('strip-b');

    // Toggle Dual Mode UI
    dualModeToggle.addEventListener('change', () => {
        if (dualModeToggle.checked) {
            stripB.classList.remove('disabled');
        } else {
            stripB.classList.add('disabled');
        }
    });

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

    // Get chip info
    async function getInfo() {
        const port = portSelect.value;
        if (!port) return;
        
        log(`Querying chip info for ${port}...`, 'system');
        infoBtn.disabled = true;
        infoBox.classList.add('hidden');
        
        try {
            const response = await fetch(`/api/info?port=${encodeURIComponent(port)}`);
            const data = await response.json();
            
            if (data.error) {
                log(`Error: ${data.error}`, 'error');
            } else {
                infoBox.textContent = data.output;
                infoBox.classList.remove('hidden');
                log('Chip info retrieved.', 'success');
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
            board: document.getElementById('board-select').value,
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
            order: 'GRB'
        };

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
        const board = document.getElementById('board-select').value;
        log(`Cleaning environment for ${board}...`, 'system');
        try {
            const resp = await fetch('/api/clean', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ board })
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

    // Initial scan
    scanPorts();
});
