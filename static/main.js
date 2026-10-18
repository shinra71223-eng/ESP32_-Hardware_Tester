document.addEventListener('DOMContentLoaded', () => {
    // ==================== STATE & CONSTANTS ====================
    const CH_COLORS = ['#00f2ff', '#ff0077', '#00ff88', '#ffaa00', '#a855f7', '#3b82f6', '#f43f5e', '#10b981'];
    let boardsRegistry = { families: [], led_chips: [] };
    let ledSheets = [];
    let activeSheetId = 'sheet_36x24_ver1';
    let libraryItems = [];
    let currentPlayingId = 'fx:rainbow'; // 'lib:<id>' | 'fx:<name>' | 'create:<type>'
    let isSimPaused = false;
    let detectedChipInfo = { chip: null, size: '4MB' };

    // Up to 8 Data Pin Channels
    let channels = [
        { pin: 2, width: 36, height: 24, zigzag: true, start_pos: 0, enabled: true }
    ];

    // Virtual LED Framebuffer (RGB uint8 array of size simW * simH * 3)
    let simW = 36;
    let simH = 24;
    let frameBuffer = new Uint8Array(simW * simH * 3);
    let animTimer = null;
    let animMode = 'rainbow';
    let animTick = 0;
    let libPlayFrames = [];
    let libPlayW = 36;
    let libPlayH = 24;
    let libPlayIdx = 0;

    // ==================== DOM ELEMENTS ====================
    const portSelect = document.getElementById('port-select');
    const studioPortSelect = document.getElementById('studio-port-select');
    const scanBtn = document.getElementById('scan-btn');
    const studioScanBtn = document.getElementById('studio-scan-btn');
    const infoBtn = document.getElementById('info-btn');
    const deployBtn = document.getElementById('deploy-btn');
    const cleanBtn = document.getElementById('clean-btn');
    const infoBox = document.getElementById('chip-info');
    const consoleBox = document.getElementById('console');

    const mcuFamilySelect = document.getElementById('mcu-family-select');
    const boardSelect = document.getElementById('board-select');
    const flashSizeSelect = document.getElementById('flash-size-select');
    const projectSelect = document.getElementById('project-select');
    const mcuDescHint = document.getElementById('mcu-desc-hint');

    const ledChipSelect = document.getElementById('led-chip-select');
    const colorOrderSelect = document.getElementById('color-order-select');
    const topologySelect = document.getElementById('topology-select');
    const channelsContainer = document.getElementById('channels-container');
    const addChannelBtn = document.getElementById('add-channel-btn');
    const zigzagToggle = document.getElementById('zigzag-toggle');
    const startPosSelect = document.getElementById('start-pos');

    const brightnessSlider = document.getElementById('brightness-slider');
    const hwBrightnessNum = document.getElementById('hw-brightness-num');
    const brightnessValueDisplay = document.getElementById('brightness-value');
    const brightnessWarning = document.getElementById('brightness-warning');
    const brightnessConsent = document.getElementById('brightness-consent');
    const mobBrightSlider = document.getElementById('mob-bright-slider');
    const mobBrightVal = document.getElementById('mob-bright-val');

    const simCanvas = document.getElementById('led-sim-canvas');
    const simCtx = simCanvas.getContext('2d');
    const mobCanvas = document.getElementById('mob-sim-canvas');
    const mobCtx = mobCanvas.getContext('2d');
    const wiringCanvas = document.getElementById('hw-wiring-canvas');
    const wiringCtx = wiringCanvas.getContext('2d');

    const simRoundLeds = document.getElementById('sim-round-leds');
    const simShowPins = document.getElementById('sim-show-pins');
    const simGlow = document.getElementById('sim-glow');
    const studioSheetPresetSelect = document.getElementById('studio-sheet-preset-select');

    // Now Playing Banner elements
    const npSourceBadge = document.getElementById('np-source-badge');
    const npCurrentTitle = document.getElementById('np-current-title');
    const simQuickClipsBar = document.getElementById('sim-quick-clips-bar');

    // ==================== MAIN WORKSPACE VIEW SWITCHING ====================
    const viewHwBtn = document.getElementById('view-hw-btn');
    const viewStudioBtn = document.getElementById('view-studio-btn');
    const viewMobileBtn = document.getElementById('view-mobile-btn');
    const hwSetupView = document.getElementById('hw-setup-view');
    const pcStudioView = document.getElementById('pc-studio-view');
    const mobileRemoteView = document.getElementById('mobile-remote-view');

    function setViewMode(mode) {
        [viewHwBtn, viewStudioBtn, viewMobileBtn].forEach(b => b.classList.remove('active'));
        [hwSetupView, pcStudioView, mobileRemoteView].forEach(v => v.classList.add('hidden'));

        if (mode === 'hardware') {
            hwSetupView.classList.remove('hidden');
            viewHwBtn.classList.add('active');
            drawWiringDiagram();
        } else if (mode === 'mobile') {
            mobileRemoteView.classList.remove('hidden');
            viewMobileBtn.classList.add('active');
            drawSimulator();
        } else {
            pcStudioView.classList.remove('hidden');
            viewStudioBtn.classList.add('active');
            drawSimulator();
        }
    }

    viewHwBtn.addEventListener('click', () => setViewMode('hardware'));
    viewStudioBtn.addEventListener('click', () => setViewMode('studio'));
    viewMobileBtn.addEventListener('click', () => setViewMode('mobile'));
    document.getElementById('mob-back-pc-btn').addEventListener('click', () => setViewMode('studio'));

    if (window.location.search.includes('view=mobile') || window.innerWidth < 680) {
        setViewMode('mobile');
    } else if (window.location.search.includes('view=hardware')) {
        setViewMode('hardware');
    }

    // Workflow 1 & 2 Guide Cards
    const wfBtnCreate = document.getElementById('wf-btn-create');
    const wfBtnSend = document.getElementById('wf-btn-send');
    const flowCreatePanel = document.getElementById('flow-create-panel');
    const flowSendPanel = document.getElementById('flow-send-panel');

    wfBtnCreate.addEventListener('click', () => {
        wfBtnCreate.classList.add('active');
        wfBtnSend.classList.remove('active');
        flowCreatePanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    wfBtnSend.addEventListener('click', () => {
        wfBtnSend.classList.add('active');
        wfBtnCreate.classList.remove('active');
        flowSendPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    // QR / Mobile Connect Modal
    const qrModal = document.getElementById('qr-modal');
    document.getElementById('qr-connect-btn').addEventListener('click', async () => {
        try {
            const r = await fetch('/api/network_info');
            const d = await r.json();
            const link = document.getElementById('qr-lan-url');
            link.href = d.mobile_remote_url;
            link.textContent = d.mobile_remote_url;
        } catch (e) {}
        qrModal.classList.remove('hidden');
    });
    document.getElementById('qr-close-btn').addEventListener('click', () => qrModal.classList.add('hidden'));
    document.getElementById('qr-preview-mobile-btn').addEventListener('click', () => {
        qrModal.classList.add('hidden');
        setViewMode('mobile');
    });

    // ==================== LOGGING ====================
    function log(message, type = 'dim') {
        const line = document.createElement('div');
        line.className = `line ${type}`;
        line.textContent = `> ${message}`;
        consoleBox.appendChild(line);
        consoleBox.parentElement.scrollTop = consoleBox.parentElement.scrollHeight;
    }

    // ==================== NOW PLAYING & QUICK SOURCE SWITCHER ====================
    function updateNowPlayingBanner(badgeText, titleText, playingKey) {
        npSourceBadge.textContent = badgeText;
        npCurrentTitle.textContent = titleText;
        document.getElementById('mob-playing-title').textContent = `再生中: ${titleText}`;
        if (playingKey) currentPlayingId = playingKey;
        renderQuickSwitcherPills();
        highlightActiveLibraryCard();
    }

    function renderQuickSwitcherPills() {
        if (!simQuickClipsBar) return;
        simQuickClipsBar.innerHTML = '';

        // 1. Saved Library Clips
        libraryItems.forEach(item => {
            const key = `lib:${item.id}`;
            const pill = document.createElement('button');
            pill.type = 'button';
            pill.className = `qs-pill ${currentPlayingId === key ? 'active' : ''}`;
            pill.innerHTML = `<span>📂</span><span>${item.title} (${item.width}×${item.height})</span>`;
            pill.addEventListener('click', () => playLibraryItem(item, false));
            simQuickClipsBar.appendChild(pill);
        });

        // 2. Built-in Effects
        const fxPresets = [
            { id: 'rainbow', label: '🌈 虹エフェクト' },
            { id: 'plasma', label: '🔮 プラズマ' },
            { id: 'fire', label: '🔥 炎マトリックス' },
            { id: 'sparkle', label: '✨ キラキラ星' }
        ];
        fxPresets.forEach(fx => {
            const key = `fx:${fx.id}`;
            const pill = document.createElement('button');
            pill.type = 'button';
            pill.className = `qs-pill ${currentPlayingId === key ? 'active' : ''}`;
            pill.textContent = fx.label;
            pill.addEventListener('click', () => {
                startSimAnim(fx.id);
                updateNowPlayingBanner('✨ 内蔵エフェクト再生中', fx.label, key);
            });
            simQuickClipsBar.appendChild(pill);
        });
    }

    function highlightActiveLibraryCard() {
        document.querySelectorAll('.lib-card[data-libid]').forEach(card => {
            const isPlaying = currentPlayingId === `lib:${card.dataset.libid}`;
            card.classList.toggle('playing-now', isPlaying);
            const simBtn = card.querySelector('.lib-sim-btn');
            if (simBtn) {
                simBtn.textContent = isPlaying ? '🟢 現在シミュレータ表示中' : '👀 シミュレータで見る';
            }
        });
    }

    // ==================== LED SHEET PRESET & SPEC TABLE MANAGER ====================
    async function loadLedSheets() {
        try {
            const r = await fetch('/api/led_sheets');
            const d = await r.json();
            ledSheets = d.sheets || [];
            renderLedSheetsUI();
        } catch (e) {
            console.error('Failed to load LED sheets:', e);
        }
    }

    function renderLedSheetsUI() {
        // 1. Populate Studio Header Preset Dropdown
        if (studioSheetPresetSelect) {
            studioSheetPresetSelect.innerHTML = ledSheets.map(s =>
                `<option value="${s.id}" ${s.id === activeSheetId ? 'selected' : ''}>${s.name} (${s.canvas_width}×${s.canvas_height})</option>`
            ).join('') + `<option value="custom" ${activeSheetId === 'custom' ? 'selected' : ''}>🔧 カスタム設定 (${simW}×${simH})</option>`;
        }

        // 2. Populate Hardware Specification Management Table
        const tbody = document.getElementById('led-sheets-tbody');
        if (!tbody) return;
        tbody.innerHTML = '';

        const posMap = ['左上 (TL)', '右上 (TR)', '左下 (BL)', '右下 (BR)'];
        const topoMap = { unified: '統合分割', independent: '独立ゾーン', mirror: 'ミラー出力' };

        ledSheets.forEach(s => {
            const isSelected = s.id === activeSheetId;
            const chs = s.channels || [];
            const pinsDesc = chs.map((c, i) => `Ch${i + 1}:P${c.pin}(${c.width}×${c.height})`).join(', ');
            const tr = document.createElement('tr');
            if (isSelected) tr.className = 'active-sheet-row';
            tr.innerHTML = `
                <td>
                    <button type="button" class="${isSelected ? 'primary-btn' : 'secondary-btn'} xs-btn apply-sheet-btn">
                        ${isSelected ? '✅ 選択中' : 'このシートを適用'}
                    </button>
                </td>
                <td style="font-family:var(--mono);font-weight:700;color:var(--primary);">${s.code || '-'}</td>
                <td><strong>${s.name}</strong></td>
                <td style="font-family:var(--mono);font-weight:700;">${s.canvas_width} × ${s.canvas_height}</td>
                <td style="font-family:var(--mono);">${s.total_leds || (s.canvas_width * s.canvas_height)} 灯</td>
                <td>${s.physical_size || '-'}</td>
                <td>${s.led_chip} (${s.voltage}V / ${s.color_order})</td>
                <td>${chs.length}ピン [${topoMap[s.topology] || s.topology}]<br><span class="hint-xs">${pinsDesc}</span></td>
                <td>${posMap[s.start_pos] || 'TL'} / ${s.zigzag ? 'Zigzag' : '順方向'}</td>
                <td style="font-family:var(--mono);text-align:center;">${s.recommended_brightness || 10}</td>
                <td class="hint-xs">${s.usage || '-'}</td>
                <td><button type="button" class="secondary-btn xs-btn del-sheet-btn" title="削除">🗑️</button></td>
            `;
            tr.querySelector('.apply-sheet-btn').addEventListener('click', () => applyLedSheetPreset(s.id));
            tr.querySelector('.del-sheet-btn').addEventListener('click', async () => {
                if (!confirm(`「${s.name}」を仕様管理表から削除しますか？`)) return;
                await fetch(`/api/led_sheets/${s.id}`, { method: 'DELETE' });
                await loadLedSheets();
            });
            tbody.appendChild(tr);
        });
    }

    function applyLedSheetPreset(sheetId) {
        const s = ledSheets.find(x => x.id === sheetId);
        if (!s) return;
        activeSheetId = s.id;
        ledChipSelect.value = s.led_chip || 'WS2812B';
        colorOrderSelect.value = s.color_order || 'GRB';
        topologySelect.value = s.topology || 'unified';
        zigzagToggle.checked = s.zigzag !== false;
        startPosSelect.value = s.start_pos || 0;
        if (s.recommended_brightness) {
            syncBrightness(s.recommended_brightness, false);
        }
        channels = (s.channels || []).map(c => ({
            pin: c.pin,
            width: c.width,
            height: c.height,
            zigzag: c.zigzag !== false,
            start_pos: c.start_pos || 0,
            enabled: true
        }));
        renderChannels();
        renderLedSheetsUI();
        log(`LEDシート仕様プリセット「${s.name} (${s.canvas_width}×${s.canvas_height})」を適用しました。`, 'success');
    }

    if (studioSheetPresetSelect) {
        studioSheetPresetSelect.addEventListener('change', e => {
            if (e.target.value === 'custom') {
                setViewMode('hardware');
            } else {
                applyLedSheetPreset(e.target.value);
            }
        });
    }

    // Modal for saving current manual settings as a new LED Sheet Spec
    const saveSheetModal = document.getElementById('save-sheet-modal');
    document.getElementById('open-save-sheet-modal-btn').addEventListener('click', () => {
        document.getElementById('new-sheet-code').value = `SONY-LED-${simW}${simH}`;
        document.getElementById('new-sheet-phys').value = `${simW * 10}mm × ${simH * 10}mm (10mmピッチ)`;
        document.getElementById('new-sheet-name').value = `${simW}×${simH} カスタムLEDシート (${channels.length}ピン)`;
        document.getElementById('new-sheet-usage').value = '';
        saveSheetModal.classList.remove('hidden');
    });
    document.getElementById('close-sheet-modal-btn').addEventListener('click', () => saveSheetModal.classList.add('hidden'));
    document.getElementById('confirm-save-sheet-btn').addEventListener('click', async () => {
        const opt = ledChipSelect.options[ledChipSelect.selectedIndex];
        const payload = {
            code: document.getElementById('new-sheet-code').value.trim(),
            name: document.getElementById('new-sheet-name').value.trim(),
            physical_size: document.getElementById('new-sheet-phys').value.trim(),
            usage: document.getElementById('new-sheet-usage').value.trim(),
            led_chip: ledChipSelect.value,
            voltage: parseInt(opt?.dataset.volt || 5),
            color_order: colorOrderSelect.value,
            canvas_width: simW,
            canvas_height: simH,
            topology: topologySelect.value,
            zigzag: zigzagToggle.checked,
            start_pos: parseInt(startPosSelect.value) || 0,
            recommended_brightness: parseInt(brightnessSlider.value) || 10,
            channels: channels
        };
        const r = await fetch('/api/led_sheets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const d = await r.json();
        if (d.success) {
            activeSheetId = d.sheet.id;
            saveSheetModal.classList.add('hidden');
            await loadLedSheets();
            log(`新しいLEDシート仕様「${d.sheet.name}」を管理表および LED_SHEETS_SPEC.md に登録しました。`, 'success');
        }
    });

    // ==================== MULTI-MCU REGISTRY ====================
    async function loadBoardsRegistry() {
        try {
            const r = await fetch('/api/boards');
            boardsRegistry = await r.json();
            updateFamilyBoards();
        } catch (e) {
            log(`Failed to load board registry: ${e.message}`, 'error');
        }
    }

    function getCurrentBoardDef() {
        const fam = boardsRegistry.families.find(f => f.id === mcuFamilySelect.value);
        if (!fam) return null;
        return fam.boards.find(b => b.id === boardSelect.value) || fam.boards[0];
    }

    function updateFamilyBoards() {
        const fam = boardsRegistry.families.find(f => f.id === mcuFamilySelect.value);
        if (!fam) return;
        mcuDescHint.textContent = fam.description || '';

        if (projectSelect.value === 'prod') {
            boardSelect.innerHTML = [
                { value: 'master_4mb', label: 'master_4mb (Serial 4MB)' },
                { value: 'master_8mb', label: 'master_8mb (Serial 8MB)' },
                { value: 'slave_8mb', label: 'slave_8mb (WiFi/UDP 8MB)' }
            ].map(e => `<option value="${e.value}">${e.label}</option>`).join('');
        } else {
            boardSelect.innerHTML = fam.boards.map(b =>
                `<option value="${b.id}">${b.name}</option>`
            ).join('');
        }
        updateBoardOptions();
    }

    function updateBoardOptions() {
        const b = getCurrentBoardDef();
        if (b && projectSelect.value !== 'prod') {
            flashSizeSelect.innerHTML = (b.flash_options || ['4MB']).map(sz =>
                `<option value="${sz}">${sz} Flash</option>`
            ).join('');
            if (detectedChipInfo.size && b.flash_options.includes(detectedChipInfo.size)) {
                flashSizeSelect.value = detectedChipInfo.size;
            }
        }
        updateHeaderBadges();
    }

    mcuFamilySelect.addEventListener('change', updateFamilyBoards);
    boardSelect.addEventListener('change', updateBoardOptions);
    flashSizeSelect.addEventListener('change', updateHeaderBadges);
    projectSelect.addEventListener('change', updateFamilyBoards);

    // ==================== MAX 8-PIN CHANNEL CONFIGURATOR ====================
    function getDefaultPinForIndex(idx) {
        const b = getCurrentBoardDef();
        const defaults = (b && b.default_pins) ? b.default_pins : [2, 4, 5, 6, 7, 15, 16, 17];
        return defaults[idx % defaults.length] || (idx + 2);
    }

    function setPinCount(count) {
        count = Math.max(1, Math.min(8, count));
        const baseW = channels[0] ? channels[0].width : 36;
        const baseH = channels[0] ? channels[0].height : 24;
        const subH = topologySelect.value === 'unified' ? Math.max(1, Math.floor(24 / count)) : baseH;

        while (channels.length < count) {
            const idx = channels.length;
            channels.push({
                pin: getDefaultPinForIndex(idx),
                width: baseW,
                height: subH,
                zigzag: zigzagToggle.checked,
                start_pos: parseInt(startPosSelect.value) || 0,
                enabled: true
            });
        }
        if (channels.length > count) {
            channels = channels.slice(0, count);
        }
        if (topologySelect.value === 'unified' && count > 1) {
            const eachH = Math.max(1, Math.round(24 / count));
            channels.forEach(c => { c.width = baseW; c.height = eachH; });
        }
        activeSheetId = 'custom';
        renderChannels();
        renderLedSheetsUI();
    }

    function renderChannels() {
        channelsContainer.innerHTML = '';
        channels.forEach((ch, idx) => {
            const color = CH_COLORS[idx % CH_COLORS.length];
            const card = document.createElement('div');
            card.className = 'ch-card';
            card.style.setProperty('--ch-color', color);
            card.innerHTML = `
                <div class="ch-tag">Ch.${idx + 1}</div>
                <div class="ch-field">
                    <span>GPIO Pin</span>
                    <input type="number" class="ch-pin-in" data-idx="${idx}" value="${ch.pin}" min="0" max="48">
                </div>
                <div class="ch-field">
                    <span>Width</span>
                    <input type="number" class="ch-w-in" data-idx="${idx}" value="${ch.width}" min="1" max="256">
                </div>
                <div class="ch-field">
                    <span>Height</span>
                    <input type="number" class="ch-h-in" data-idx="${idx}" value="${ch.height}" min="1" max="256">
                </div>
                <button type="button" class="ch-del-btn" data-idx="${idx}" title="削除" ${channels.length <= 1 ? 'disabled' : ''}>✕</button>
            `;
            channelsContainer.appendChild(card);
        });

        channelsContainer.querySelectorAll('.ch-pin-in').forEach(el => {
            el.addEventListener('input', e => {
                channels[+e.target.dataset.idx].pin = parseInt(e.target.value) || 0;
                activeSheetId = 'custom';
                syncDimensionsAndUI();
                renderLedSheetsUI();
            });
        });
        channelsContainer.querySelectorAll('.ch-w-in').forEach(el => {
            el.addEventListener('input', e => {
                channels[+e.target.dataset.idx].width = Math.max(1, parseInt(e.target.value) || 1);
                activeSheetId = 'custom';
                syncDimensionsAndUI();
                renderLedSheetsUI();
            });
        });
        channelsContainer.querySelectorAll('.ch-h-in').forEach(el => {
            el.addEventListener('input', e => {
                channels[+e.target.dataset.idx].height = Math.max(1, parseInt(e.target.value) || 1);
                activeSheetId = 'custom';
                syncDimensionsAndUI();
                renderLedSheetsUI();
            });
        });
        channelsContainer.querySelectorAll('.ch-del-btn').forEach(el => {
            el.addEventListener('click', e => {
                const idx = +e.currentTarget.dataset.idx;
                if (channels.length > 1) {
                    channels.splice(idx, 1);
                    activeSheetId = 'custom';
                    renderChannels();
                    renderLedSheetsUI();
                }
            });
        });

        document.querySelectorAll('.pin-preset-btn').forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.pins) === channels.length);
        });

        renderChannelMaskButtons();
        syncDimensionsAndUI();
    }

    function renderChannelMaskButtons() {
        const maskGrid = document.getElementById('ch-mask-grid');
        maskGrid.innerHTML = '';
        channels.forEach((ch, idx) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `ch-mask-btn ${ch.enabled ? '' : 'muted'}`;
            btn.textContent = `Ch.${idx + 1} (P${ch.pin})`;
            btn.addEventListener('click', () => {
                ch.enabled = !ch.enabled;
                renderChannelMaskButtons();
                drawSimulator();
            });
            maskGrid.appendChild(btn);
        });
    }

    function syncDimensionsAndUI() {
        const topo = topologySelect.value;
        let totalW = channels[0].width;
        let totalH = channels[0].height;
        if (topo === 'unified' && channels.length > 1) {
            totalW = Math.max(...channels.map(c => c.width));
            totalH = channels.reduce((acc, c) => acc + c.height, 0);
        }

        if (totalW !== simW || totalH !== simH) {
            simW = Math.max(1, Math.min(256, totalW));
            simH = Math.max(1, Math.min(256, totalH));
            frameBuffer = new Uint8Array(simW * simH * 3);
        }

        document.getElementById('dual-mode-toggle').checked = channels.length >= 2;
        document.getElementById('pin-a').value = channels[0].pin;
        document.getElementById('width-a').value = simW;
        document.getElementById('height-a').value = simH;
        if (channels[1]) {
            document.getElementById('pin-b').value = channels[1].pin;
            document.getElementById('width-b').value = channels[1].width;
            document.getElementById('height-b').value = channels[1].height;
        }
        document.getElementById('video-width').value = simW;
        document.getElementById('video-height').value = simH;

        document.getElementById('active-pins-badge').textContent = `${channels.length} / 8 Pins`;
        const posNames = ['TL (左上)', 'TR (右上)', 'BL (左下)', 'BR (右下)'];
        const pinSummary = channels.map((c, i) => `Ch.${i + 1}:GPIO${c.pin}(${c.width}×${c.height})`).join(' · ');
        document.getElementById('sim-info-text').textContent =
            `${simW}×${simH} (${simW * simH}灯) | ${pinSummary}`;
        document.getElementById('hw-wiring-summary').textContent =
            `${simW}×${simH} · ${channels.length}Pin · 起点:${posNames[+startPosSelect.value]} · Zigzag:${zigzagToggle.checked ? 'ON' : 'OFF'}`;

        updateHeaderBadges();
        drawWiringDiagram();
        drawSimulator();
    }

    document.querySelectorAll('.pin-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => setPinCount(parseInt(btn.dataset.pins)));
    });
    addChannelBtn.addEventListener('click', () => {
        if (channels.length < 8) setPinCount(channels.length + 1);
    });
    topologySelect.addEventListener('change', syncDimensionsAndUI);
    zigzagToggle.addEventListener('change', syncDimensionsAndUI);
    startPosSelect.addEventListener('change', syncDimensionsAndUI);
    ledChipSelect.addEventListener('change', updateHeaderBadges);
    document.getElementById('demo-clips').addEventListener('input', () => {
        updateHeaderBadges();
        renderLibraryGrid(libraryItems);
    });

    // ==================== HARDWARE WIRING DIAGRAM RENDERER ====================
    function drawWiringDiagram() {
        if (!wiringCanvas) return;
        const cw = wiringCanvas.width;
        const ch = wiringCanvas.height;
        wiringCtx.fillStyle = '#04060b';
        wiringCtx.fillRect(0, 0, cw, ch);

        const padX = 24, padY = 16;
        const availW = cw - padX * 2;
        const availH = ch - padY * 2;

        let curY = 0;
        const totalH = Math.max(1, simH);
        const startPos = parseInt(startPosSelect.value) || 0;
        const isZigzag = zigzagToggle.checked;

        channels.forEach((c, idx) => {
            const color = CH_COLORS[idx % CH_COLORS.length];
            const ratioH = topologySelect.value === 'unified' ? (c.height / totalH) : (1.0 / channels.length);
            const bandH = Math.max(24, availH * ratioH - 4);
            const bx = padX;
            const by = padY + curY;

            wiringCtx.fillStyle = 'rgba(255,255,255,0.03)';
            wiringCtx.fillRect(bx, by, availW, bandH);
            wiringCtx.strokeStyle = color;
            wiringCtx.lineWidth = 1.8;
            wiringCtx.strokeRect(bx, by, availW, bandH);

            wiringCtx.fillStyle = color;
            wiringCtx.font = 'bold 12px JetBrains Mono, monospace';
            const ledCount = c.width * c.height;
            wiringCtx.fillText(
                `Ch.${idx + 1} [GPIO ${c.pin}] — ${c.width}×${c.height} (${ledCount} LEDs)`,
                bx + 10, by + 18
            );

            const lines = 3;
            const lineX0 = bx + 260;
            const lineX1 = bx + availW - 22;
            if (lineX1 > lineX0 + 40 && bandH >= 26) {
                wiringCtx.strokeStyle = color;
                wiringCtx.globalAlpha = 0.65;
                wiringCtx.lineWidth = 1.5;
                wiringCtx.beginPath();
                for (let r = 0; r < lines; r++) {
                    const ly = by + 8 + ((bandH - 16) / Math.max(1, lines - 1)) * r;
                    const leftToRight = (startPos === 0 || startPos === 2)
                        ? (isZigzag ? (r % 2 === 0) : true)
                        : (isZigzag ? (r % 2 !== 0) : false);
                    if (r === 0) {
                        wiringCtx.moveTo(leftToRight ? lineX0 : lineX1, ly);
                        wiringCtx.lineTo(leftToRight ? lineX1 : lineX0, ly);
                    } else {
                        wiringCtx.lineTo(leftToRight ? lineX0 : lineX1, ly);
                        wiringCtx.lineTo(leftToRight ? lineX1 : lineX0, ly);
                    }
                }
                wiringCtx.stroke();
                wiringCtx.globalAlpha = 1.0;

                const startX = (startPos === 0 || startPos === 2) ? lineX0 : lineX1;
                const startY = (startPos === 0 || startPos === 1) ? (by + 8) : (by + bandH - 8);
                wiringCtx.fillStyle = '#00ff88';
                wiringCtx.beginPath();
                wiringCtx.arc(startX, startY, 4.5, 0, Math.PI * 2);
                wiringCtx.fill();
                wiringCtx.font = 'bold 10px JetBrains Mono, monospace';
                wiringCtx.fillText('★No.1', startX - 18, startY - 6);
            }

            curY += bandH + 4;
        });
    }

    // ==================== POWER & TELEMETRY ESTIMATOR ====================
    function updateHeaderBadges() {
        const fSize = flashSizeSelect.value || '4MB';
        const totalLeds = simW * simH;
        document.getElementById('hdr-matrix-badge').textContent =
            `${simW}×${simH} (${totalLeds}灯) · ${channels.length} Pin`;

        const maxMb = fSize.includes('8') ? 7.3 : (fSize.includes('16') ? 14.0 : 3.3);
        const clipLines = document.getElementById('demo-clips').value.split('\n').map(s => s.trim()).filter(Boolean);
        const estMb = Math.min(maxMb, clipLines.length * (totalLeds * 3 * 150) / 1e6);
        document.getElementById('flash-usage-label').textContent = `~${estMb.toFixed(2)} / ${maxMb.toFixed(2)} MB (${clipLines.length}件登録中)`;
        document.getElementById('flash-meter-fill').style.width = `${Math.min(100, (estMb / maxMb) * 100)}%`;

        updatePowerEstimate();
    }

    function updatePowerEstimate() {
        const opt = ledChipSelect.options[ledChipSelect.selectedIndex];
        const voltage = parseFloat(opt?.dataset.volt || 5);
        const maxMaPerLed = parseFloat(opt?.dataset.ma || 45);
        const brightScale = parseInt(brightnessSlider.value) / 255.0;

        const totalLeds = simW * simH;
        let sumChannelFraction = 0;
        const len = frameBuffer.length;
        for (let i = 0; i < len; i++) {
            sumChannelFraction += frameBuffer[i] / 255.0;
        }
        const avgLitFactor = len > 0 ? (sumChannelFraction / len) : 0.25;
        const idleAmps = (totalLeds * 0.8) / 1000.0;
        const activeAmps = (totalLeds * maxMaPerLed * avgLitFactor * brightScale) / 1000.0;
        const totalAmps = idleAmps + activeAmps;
        const totalWatts = totalAmps * voltage;

        const pVal = document.getElementById('hdr-power-value');
        pVal.textContent = `${totalAmps.toFixed(2)} A / ${totalWatts.toFixed(1)} W (${voltage}V)`;
        document.getElementById('mob-power-badge').textContent = `${totalAmps.toFixed(2)} A`;

        const pct = Math.min(100, (totalAmps / 10.0) * 100);
        document.getElementById('hdr-power-bar').style.width = `${Math.max(4, pct)}%`;
    }

    // ==================== VIRTUAL LED MATRIX SIMULATOR ====================
    function drawSimulator() {
        renderMatrixOnCanvas(simCanvas, simCtx, true);
        renderMatrixOnCanvas(mobCanvas, mobCtx, false);
        updatePowerEstimate();
    }

    function renderMatrixOnCanvas(canvas, ctx, showOverlays) {
        const cw = canvas.width;
        const ch = canvas.height;
        ctx.fillStyle = '#04060a';
        ctx.fillRect(0, 0, cw, ch);

        const pad = 16;
        const availW = cw - pad * 2;
        const availH = ch - pad * 2;
        const cell = Math.max(2, Math.min(availW / simW, availH / simH));
        const gridW = cell * simW;
        const gridH = cell * simH;
        const ox = (cw - gridW) / 2;
        const oy = (ch - gridH) / 2;

        const isRound = simRoundLeds.checked;
        const useGlow = simGlow.checked;
        const bFactor = 0.35 + 0.65 * Math.pow(parseInt(brightnessSlider.value) / 255.0, 0.45);

        for (let y = 0; y < simH; y++) {
            for (let x = 0; x < simW; x++) {
                const p = (y * simW + x) * 3;
                const r = Math.min(255, Math.round(frameBuffer[p] * bFactor));
                const g = Math.min(255, Math.round(frameBuffer[p + 1] * bFactor));
                const b = Math.min(255, Math.round(frameBuffer[p + 2] * bFactor));

                const px = ox + x * cell;
                const py = oy + y * cell;

                if (r < 4 && g < 4 && b < 4) {
                    ctx.fillStyle = '#121622';
                } else {
                    ctx.fillStyle = `rgb(${r},${g},${b})`;
                }

                if (isRound) {
                    ctx.beginPath();
                    ctx.arc(px + cell / 2, py + cell / 2, Math.max(1, cell * 0.41), 0, Math.PI * 2);
                    ctx.fill();
                } else {
                    ctx.fillRect(px + 1, py + 1, Math.max(1, cell - 2), Math.max(1, cell - 2));
                }

                if (useGlow && (r > 40 || g > 40 || b > 40) && cell >= 6) {
                    ctx.fillStyle = `rgba(${r},${g},${b},0.22)`;
                    ctx.beginPath();
                    ctx.arc(px + cell / 2, py + cell / 2, cell * 0.68, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }

        if (showOverlays && simShowPins.checked) {
            let curY = 0;
            channels.forEach((c, idx) => {
                const color = CH_COLORS[idx % CH_COLORS.length];
                const bandH = topologySelect.value === 'unified' ? c.height : simH;
                const yStart = oy + curY * cell;
                const yHeight = Math.min(gridH - curY * cell, bandH * cell);

                if (yHeight > 0) {
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 1.5;
                    ctx.setLineDash([4, 3]);
                    ctx.strokeRect(ox, yStart, gridW, yHeight);
                    ctx.setLineDash([]);

                    ctx.fillStyle = 'rgba(5, 8, 15, 0.82)';
                    ctx.fillRect(ox + 4, yStart + 4, 118, 18);
                    ctx.fillStyle = color;
                    ctx.font = 'bold 11px JetBrains Mono, monospace';
                    ctx.fillText(`Ch.${idx + 1} GPIO:${c.pin}`, ox + 8, yStart + 16);
                }
                if (topologySelect.value === 'unified') {
                    curY += c.height;
                }
            });
        }
    }

    [simRoundLeds, simShowPins, simGlow].forEach(el => el.addEventListener('change', drawSimulator));

    // ==================== PROCEDURAL ANIMATIONS & SIMULATOR ENGINE ====================
    function hsvToRgb(h, s, v) {
        let f = (n, k = (n + h / 60) % 6) => v - v * s * Math.max(Math.min(k, 4 - k, 1), 0);
        return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
    }

    function fitRgbBufferToSim(srcBytes, srcW, srcH) {
        if (srcW === simW && srcH === simH && srcBytes.length === frameBuffer.length) {
            frameBuffer.set(srcBytes);
            return;
        }
        for (let y = 0; y < simH; y++) {
            const sy = Math.min(srcH - 1, Math.floor((y * srcH) / simH));
            for (let x = 0; x < simW; x++) {
                const sx = Math.min(srcW - 1, Math.floor((x * srcW) / simW));
                const sp = (sy * srcW + sx) * 3;
                const dp = (y * simW + x) * 3;
                frameBuffer[dp] = srcBytes[sp] || 0;
                frameBuffer[dp + 1] = srcBytes[sp + 1] || 0;
                frameBuffer[dp + 2] = srcBytes[sp + 2] || 0;
            }
        }
    }

    function stepProceduralFrame() {
        if (isSimPaused) return;
        animTick++;
        const cx = (simW - 1) / 2;
        const cy = (simH - 1) / 2;
        const maxD = Math.sqrt(cx * cx + cy * cy) || 1;

        if (animMode === 'library' && libPlayFrames.length > 0) {
            const raw = libPlayFrames[libPlayIdx % libPlayFrames.length];
            fitRgbBufferToSim(raw, libPlayW, libPlayH);
            libPlayIdx++;
            drawSimulator();
            return;
        }

        if (animMode === 'marquee') {
            renderMarqueeFrame();
            drawSimulator();
            return;
        }

        for (let y = 0; y < simH; y++) {
            for (let x = 0; x < simW; x++) {
                const p = (y * simW + x) * 3;
                if (animMode === 'rainbow') {
                    const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
                    const hue = (animTick * 4 + (d / maxD) * 220) % 360;
                    const [r, g, b] = hsvToRgb(hue, 0.95, 1.0);
                    frameBuffer[p] = r; frameBuffer[p + 1] = g; frameBuffer[p + 2] = b;
                } else if (animMode === 'plasma') {
                    const v = Math.sin(x * 0.28 + animTick * 0.08) +
                              Math.sin(y * 0.32 + animTick * 0.06) +
                              Math.sin((x + y) * 0.2 + animTick * 0.1);
                    const hue = ((v + 3) * 60 + animTick * 2) % 360;
                    const [r, g, b] = hsvToRgb(hue, 0.9, 1.0);
                    frameBuffer[p] = r; frameBuffer[p + 1] = g; frameBuffer[p + 2] = b;
                } else if (animMode === 'fire') {
                    const heat = Math.max(0, Math.min(1, ((y / simH) * 0.85) + (Math.sin(x * 0.7 + animTick * 0.25) * 0.2) - Math.random() * 0.22));
                    const [r, g, b] = hsvToRgb(heat * 45, 1.0, Math.min(1, heat * 1.3));
                    frameBuffer[p] = r; frameBuffer[p + 1] = g; frameBuffer[p + 2] = b;
                } else if (animMode === 'matrix') {
                    const colPhase = ((x * 17) + Math.floor(animTick * 0.6)) % (simH + 8);
                    const dist = (y - colPhase + simH) % simH;
                    const gVal = dist === 0 ? 255 : (dist < 6 ? Math.max(0, 200 - dist * 35) : 0);
                    frameBuffer[p] = dist === 0 ? 180 : 0;
                    frameBuffer[p + 1] = gVal;
                    frameBuffer[p + 2] = dist === 0 ? 180 : 0;
                } else if (animMode === 'sparkle') {
                    frameBuffer[p] = Math.max(0, frameBuffer[p] - 22);
                    frameBuffer[p + 1] = Math.max(0, frameBuffer[p + 1] - 22);
                    frameBuffer[p + 2] = Math.max(0, frameBuffer[p + 2] - 22);
                    if (Math.random() < 0.03) {
                        frameBuffer[p] = 255; frameBuffer[p + 1] = 255; frameBuffer[p + 2] = 255;
                    }
                }
            }
        }
        drawSimulator();
    }

    function startSimAnim(mode) {
        isSimPaused = false;
        animMode = mode;
        if (animTimer) clearInterval(animTimer);
        animTimer = setInterval(stepProceduralFrame, 33);
    }

    function stopSimAnim() {
        if (animTimer) {
            clearInterval(animTimer);
            animTimer = null;
        }
    }

    document.getElementById('sim-pause-btn').addEventListener('click', () => {
        isSimPaused = !isSimPaused;
        document.getElementById('video-status').textContent = isSimPaused ? 'PAUSED' : 'SIMULATOR PLAYING';
    });
    document.getElementById('sim-blackout-btn').addEventListener('click', () => {
        stopSimAnim();
        frameBuffer.fill(0);
        updateNowPlayingBanner('🌑 消灯状態', '画面クリア (Blackout)', 'none');
        drawSimulator();
    });

    // ==================== BRIGHTNESS & SAFETY CONTROL ====================
    function syncBrightness(val, sendLive = false) {
        val = Math.max(1, Math.min(255, parseInt(val) || 10));
        brightnessSlider.value = val;
        if (hwBrightnessNum) hwBrightnessNum.value = val;
        mobBrightSlider.value = val;
        brightnessValueDisplay.textContent = val;
        mobBrightVal.textContent = `${val} / 255`;

        if (val > 10) {
            brightnessWarning.classList.remove('hidden');
        } else {
            brightnessWarning.classList.add('hidden');
            brightnessConsent.checked = false;
        }
        drawSimulator();

        if (sendLive && portSelect.value) {
            fetch('/api/live/control', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ port: portSelect.value, cmd: 'brightness', value: val })
            }).catch(() => {});
        }
    }

    brightnessSlider.addEventListener('input', e => syncBrightness(e.target.value, false));
    brightnessSlider.addEventListener('change', e => syncBrightness(e.target.value, true));
    if (hwBrightnessNum) {
        hwBrightnessNum.addEventListener('input', e => syncBrightness(e.target.value, false));
    }
    mobBrightSlider.addEventListener('input', e => syncBrightness(e.target.value, false));
    mobBrightSlider.addEventListener('change', e => syncBrightness(e.target.value, true));

    // ==================== PORT SCAN, CHIP INFO & DEPLOY ====================
    async function scanPorts() {
        log('Scanning serial ports...', 'system');
        scanBtn.disabled = true;
        if (studioScanBtn) studioScanBtn.disabled = true;
        try {
            const response = await fetch('/api/scan');
            const data = await response.json();
            const prevVal = portSelect.value;
            const optsHtml = '<option value="">ポート未選択 (シミュレータのみ)</option>' + data.map(item =>
                `<option value="${item.device}">${item.device} - ${item.description} ${item.is_likely ? '✨' : ''}</option>`
            ).join('');
            portSelect.innerHTML = optsHtml;
            if (studioPortSelect) studioPortSelect.innerHTML = optsHtml;
            if (prevVal) {
                portSelect.value = prevVal;
                if (studioPortSelect) studioPortSelect.value = prevVal;
            }
            log(`Found ${data.length} port(s).`);
        } catch (err) {
            log(`Scan failed: ${err.message}`, 'error');
        }
        scanBtn.disabled = false;
        if (studioScanBtn) studioScanBtn.disabled = false;
    }

    function onPortChanged(val) {
        portSelect.value = val;
        if (studioPortSelect) studioPortSelect.value = val;
        infoBtn.disabled = !val;
        const sb = document.getElementById('status-badge');
        if (val) {
            sb.textContent = `接続中 (${val})`;
            sb.className = 'badge active';
        } else {
            sb.textContent = '未接続 (Simのみ)';
            sb.className = 'badge';
        }
    }

    portSelect.addEventListener('change', e => onPortChanged(e.target.value));
    if (studioPortSelect) {
        studioPortSelect.addEventListener('change', e => onPortChanged(e.target.value));
    }

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
                detectedChipInfo.chip = data.chip;
                detectedChipInfo.size = data.size;
                document.getElementById('detected-chip-name').textContent = data.chip;
                document.getElementById('size-badge').textContent = data.size;
                document.getElementById('chip-badge').textContent = data.chip;
                document.getElementById('chip-status').classList.remove('hidden');
                flashSizeSelect.value = data.size;
                updateHeaderBadges();
                log(`Chip identified: ${data.chip} (${data.size})`, 'success');
            }
        } catch (err) {
            log(`Request failed: ${err.message}`, 'error');
        }
        infoBtn.disabled = false;
    }

    async function deploy() {
        const port = portSelect.value;
        if (!port) {
            alert('先にシリアルポートを選択してください (Select a port first).');
            return;
        }
        const brightness = parseInt(brightnessSlider.value);
        if (brightness > 10 && !brightnessConsent.checked) {
            log('⚠️ 輝度が10を超えています。Studio画面右カラムの電流量注意の警告に同意チェックを入れてください。', 'error');
            alert('輝度が10を超えています。安全のため輝度を10以下にするか、Studioタブの「電流量注意」に同意チェックを入れてください。');
            return;
        }

        const config = {
            port: port,
            project: projectSelect.value,
            board: boardSelect.value,
            flash_size: flashSizeSelect.value || detectedChipInfo.size,
            led_chip: ledChipSelect.value,
            topology: topologySelect.value,
            channels: channels,
            canvas_width: simW,
            canvas_height: simH,
            is_dual: channels.length >= 2,
            pin_a: channels[0].pin,
            width_a: simW,
            height_a: simH,
            pin_b: channels[1] ? channels[1].pin : 4,
            width_b: channels[1] ? channels[1].width : simW,
            height_b: channels[1] ? channels[1].height : simH,
            zigzag: zigzagToggle.checked,
            start_pos: parseInt(startPosSelect.value),
            test_mode: parseInt(document.getElementById('test-mode').value),
            brightness: brightness,
            demo_clips: document.getElementById('demo-clips').value.split('\n').map(s => s.trim()).filter(Boolean),
            demo_fit: document.getElementById('demo-fit').value,
            demo_fade_ms: parseInt(document.getElementById('demo-fade').value) || 0,
            order: colorOrderSelect.value
        };

        log(`Starting firmware deployment (${config.board}, ${channels.length} pin(s), ${simW}x${simH})...`, 'system');
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
                        if (data.type === 'log') log(data.content, 'dim');
                        else if (data.type === 'status') {
                            if (data.success) log('DEPLOYMENT SUCCESSFUL!', 'success');
                            else log('DEPLOYMENT FAILED. Try "Clean" if errors persist.', 'error');
                        } else if (data.type === 'error') log(`Error: ${data.content}`, 'error');
                    } catch (e) {}
                }
            }
        } catch (err) {
            log(`Deploy error: ${err.message}`, 'error');
        }
        deployBtn.disabled = false;
    }

    async function cleanBuild() {
        const board = boardSelect.value;
        const project = projectSelect.value;
        log(`Cleaning PIO build for ${board}...`, 'system');
        try {
            const r = await fetch('/api/clean', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ board, project })
            });
            const d = await r.json();
            if (d.success) log('Clean successful.', 'success');
            else log(`Clean failed: ${d.error || d.output}`, 'error');
        } catch (e) {
            log(`Clean error: ${e.message}`, 'error');
        }
    }

    scanBtn.addEventListener('click', scanPorts);
    if (studioScanBtn) studioScanBtn.addEventListener('click', scanPorts);
    infoBtn.addEventListener('click', getInfo);
    deployBtn.addEventListener('click', deploy);
    cleanBtn.addEventListener('click', cleanBuild);

    // ==================== STUDIO TABS & MOBILE TABS ====================
    document.querySelectorAll('.studio-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.studio-tab').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.tab).classList.add('active');
        });
    });

    document.querySelectorAll('.mob-nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.mob-nav-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.mob-pane').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.mobtab).classList.add('active');
        });
    });

    // ==================== FLOW 1: CREATE -> PREVIEW -> SAVE ====================
    const vFile = document.getElementById('video-file');
    const vW = document.getElementById('video-width');
    const vH = document.getElementById('video-height');
    const vFps = document.getElementById('video-fps');
    const vFit = document.getElementById('video-fit');
    const vPos = document.getElementById('video-pos');
    const vPreviewBtn = document.getElementById('video-preview-btn');
    const convSaveLibBtn = document.getElementById('conv-save-lib-btn');
    const vStopBtn = document.getElementById('video-stop-btn');
    const vStatus = document.getElementById('video-status');

    const convGamma = document.getElementById('conv-gamma');
    const convContrast = document.getElementById('conv-contrast');
    const convSat = document.getElementById('conv-sat');
    const convCutoff = document.getElementById('conv-cutoff');
    const convZoom = document.getElementById('conv-zoom');
    const convTitle = document.getElementById('conv-title');

    let videoLoaded = false;
    let statusTimer = null;

    function getGradingParams() {
        return {
            width: +vW.value || simW,
            height: +vH.value || simH,
            fps: +vFps.value || 30,
            fit: vFit.value,
            pos: (+vPos.value || 0) / 100.0,
            gamma: parseFloat(convGamma.value) || 2.2,
            contrast: parseFloat(convContrast.value) || 1.0,
            saturation: parseFloat(convSat.value) || 1.0,
            black_cutoff: parseInt(convCutoff.value) || 0,
            zoom: parseFloat(convZoom.value) || 1.0,
            title: convTitle.value.trim()
        };
    }

    function bindGradingSliders() {
        const pairs = [
            [convGamma, 'lbl-gamma', v => v],
            [convContrast, 'lbl-contrast', v => v],
            [convSat, 'lbl-sat', v => v],
            [convCutoff, 'lbl-cutoff', v => v],
            [convZoom, 'lbl-zoom', v => `${v}x`],
            [vPos, 'lbl-pos', v => `${v}%`]
        ];
        pairs.forEach(([el, lblId, fmt]) => {
            el.addEventListener('input', () => {
                document.getElementById(lblId).textContent = fmt(el.value);
            });
            el.addEventListener('change', () => {
                if (videoLoaded) previewConvertedFrame();
            });
        });
    }
    bindGradingSliders();

    vFile.addEventListener('change', async () => {
        const file = vFile.files[0];
        if (!file) return;
        log(`Uploading source media: ${file.name}`, 'system');
        const fd = new FormData();
        fd.append('file', file);
        try {
            const r = await fetch('/api/video/upload', { method: 'POST', body: fd });
            const d = await r.json();
            if (d.error) {
                log(`Upload error: ${d.error}`, 'error');
                return;
            }
            videoLoaded = true;
            convTitle.value = d.name || file.name.replace(/\.[^.]+$/, '');
            document.getElementById('video-meta').textContent =
                `✅ 読込完了: ${d.width}×${d.height} | ${d.fps.toFixed(1)} FPS | ${d.frames} フレーム (${d.duration}秒)`;
            vPreviewBtn.disabled = false;
            convSaveLibBtn.disabled = false;
            await previewConvertedFrame();
        } catch (e) {
            log(`Upload failed: ${e.message}`, 'error');
        }
    });

    async function previewConvertedFrame() {
        if (!videoLoaded) return;
        stopSimAnim();
        const params = getGradingParams();
        try {
            const r = await fetch('/api/video/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params)
            });
            const d = await r.json();
            if (d.error) return;
            if (d.raw_rgb) {
                const raw = Uint8Array.from(atob(d.raw_rgb), c => c.charCodeAt(0));
                fitRgbBufferToSim(raw, d.width, d.height);
                updateNowPlayingBanner('🎬 動画変換プレビュー中', `${params.title || '選択中の動画'} (位置 ${vPos.value}%)`, 'create:video');
                drawSimulator();
            }
        } catch (e) {}
    }

    vPreviewBtn.addEventListener('click', previewConvertedFrame);
    [vW, vH, vFit].forEach(el => el.addEventListener('change', previewConvertedFrame));

    convSaveLibBtn.addEventListener('click', async () => {
        if (!videoLoaded) return;
        convSaveLibBtn.disabled = true;
        const params = getGradingParams();
        log(`Converting "${params.title}" to LED source (.ledbin)...`, 'system');
        try {
            const r = await fetch('/api/library/convert', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params)
            });
            const d = await r.json();
            if (d.error) {
                alert(`変換エラー: ${d.error}`);
            } else {
                await loadLibrary(false);
                await playLibraryItem(d.item, false);
                wfBtnSend.click();
            }
        } catch (e) {
            log(`Convert error: ${e.message}`, 'error');
        }
        convSaveLibBtn.disabled = false;
    });

    // ==================== FLOW 2: SAVED LIBRARY BROWSER & SENDER ====================
    async function loadLibrary(autoPlayFirst = false) {
        try {
            const r = await fetch('/api/library');
            libraryItems = await r.json();
            document.getElementById('wf-lib-count').textContent = libraryItems.length;
            renderLibraryGrid(libraryItems);
            renderQuickSwitcherPills();

            if (autoPlayFirst && libraryItems.length > 0) {
                await playLibraryItem(libraryItems[0], false);
            }
        } catch (e) {
            console.error(e);
        }
    }

    function renderLibraryGrid(items) {
        const pcGrid = document.getElementById('library-grid');
        const mobList = document.getElementById('mob-library-list');
        pcGrid.innerHTML = '';
        mobList.innerHTML = '';

        if (!items.length) {
            const emptyHtml = `<div class="hint-xs" style="padding:18px;text-align:center;">まだ保存されたLEDデータがありません。上の「FLOW 1」でデータを作成して「💾 保存」を押してください。</div>`;
            pcGrid.innerHTML = emptyHtml;
            mobList.innerHTML = emptyHtml;
            return;
        }

        const flashListText = document.getElementById('demo-clips').value;

        items.forEach(item => {
            const kb = (item.size_bytes / 1024).toFixed(1);
            const isPlaying = currentPlayingId === `lib:${item.id}`;
            const isInFlash = flashListText.includes(item.filename) || flashListText.includes(item.title.split(' ')[0]);

            const card = document.createElement('div');
            card.className = `lib-card ${isPlaying ? 'playing-now' : ''}`;
            card.dataset.libid = item.id;
            card.innerHTML = `
                <div class="lib-card-top">
                    <img class="lib-thumb" src="${item.thumbnail || ''}" alt="${item.title}">
                    <div class="lib-info">
                        <div class="lib-title">${item.title}</div>
                        <div class="lib-meta">解像度: ${item.width}×${item.height} · ${item.fps}fps · ${item.duration_sec}秒 (${item.frames}f / ${kb}KB)</div>
                    </div>
                </div>
                <div class="lib-actions">
                    <button type="button" class="secondary-btn xs-btn lib-sim-btn">
                        ${isPlaying ? '🟢 現在シミュレータ表示中' : '👀 シミュレータで見る'}
                    </button>
                    <button type="button" class="primary-btn xs-btn lib-live-btn" title="USB接続中のLED実機へ今すぐリアルタイム投影します">
                        📡 実機へライブ送信
                    </button>
                    <button type="button" class="secondary-btn xs-btn lib-flash-btn" title="マイコン本体メモリ(FW)の内蔵デモリストへ追加します">
                        ${isInFlash ? '✅ FW内蔵登録済' : '⚡ 本体メモリ(FW)に登録'}
                    </button>
                    <a href="/api/library/download/${item.id}" class="secondary-btn xs-btn" style="text-decoration:none;" title=".ledbinファイルを保存">📥</a>
                    <button type="button" class="secondary-btn xs-btn lib-del-btn" title="削除">🗑️</button>
                </div>
            `;

            card.querySelector('.lib-sim-btn').addEventListener('click', () => playLibraryItem(item, false));
            card.querySelector('.lib-live-btn').addEventListener('click', () => playLibraryItem(item, true));
            card.querySelector('.lib-flash-btn').addEventListener('click', () => {
                const ta = document.getElementById('demo-clips');
                const cur = ta.value.trim();
                if (!cur.includes(item.filename)) {
                    ta.value = cur ? `${cur}\n${item.filename}` : item.filename;
                    updateHeaderBadges();
                    renderLibraryGrid(libraryItems);
                }
                alert(`「${item.title}」をマイコン本体メモリ(FW)の書き込みリストに登録しました！\n上部の「🛠️ 2. LEDシート仕様管理 & FW書込」タブから実機へ書き込めます。`);
            });
            card.querySelector('.lib-del-btn').addEventListener('click', async () => {
                if (!confirm(`「${item.title}」を削除しますか？`)) return;
                await fetch(`/api/library/delete/${item.id}`, { method: 'DELETE' });
                loadLibrary(false);
            });
            pcGrid.appendChild(card);

            // Mobile Card
            const mCard = document.createElement('div');
            mCard.className = `lib-card ${isPlaying ? 'playing-now' : ''}`;
            mCard.innerHTML = `
                <div class="lib-card-top">
                    <img class="lib-thumb" src="${item.thumbnail || ''}" alt="${item.title}">
                    <div class="lib-info">
                        <div class="lib-title">${item.title}</div>
                        <div class="lib-meta">${item.width}×${item.height} · ${item.duration_sec}s (${kb}KB)</div>
                    </div>
                    <button type="button" class="primary-btn compact-btn" style="flex:0;">▶️ 再生/送信</button>
                </div>
            `;
            mCard.querySelector('button').addEventListener('click', () => playLibraryItem(item, true));
            mobList.appendChild(mCard);
        });
    }

    async function playLibraryItem(item, sendToHardware = false) {
        updateNowPlayingBanner(
            sendToHardware && portSelect.value ? '📡 実機へライブ送信中' : '📂 保存済みデータ再生中',
            `${item.title} (${item.width}×${item.height})`,
            `lib:${item.id}`
        );

        if (sendToHardware) {
            if (!portSelect.value) {
                alert('現在シリアルポートが未選択のため、シミュレータ上で再生します。\n実機に流す場合は右側の「🔌 実機接続ポート」を選択してください。');
            } else {
                vStopBtn.disabled = false;
                vStatus.textContent = `LIVE TX: ${item.title}`;
                fetch('/api/video/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        port: portSelect.value,
                        library_id: item.id,
                        width: item.width,
                        height: item.height,
                        loop: true,
                        fps: item.fps
                    })
                }).catch(() => {});
            }
        } else {
            vStatus.textContent = 'SIMULATOR PLAYING';
        }

        try {
            const r = await fetch(`/api/library/frames/${item.id}`);
            const d = await r.json();
            if (d.frames && d.frames.length) {
                libPlayW = d.width || item.width;
                libPlayH = d.height || item.height;
                libPlayFrames = d.frames.map(b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
                libPlayIdx = 0;
                startSimAnim('library');
            }
        } catch (e) {}
    }

    document.getElementById('refresh-lib-btn').addEventListener('click', () => loadLibrary(false));

    function stopAllStreams() {
        fetch('/api/video/stop', { method: 'POST' }).catch(() => {});
        stopSimAnim();
        vStatus.textContent = 'STOPPED';
        vStopBtn.disabled = true;
    }

    vStopBtn.addEventListener('click', stopAllStreams);
    document.getElementById('mob-stop-btn').addEventListener('click', stopAllStreams);

    // ==================== PIXEL ART DRAWING ON SIMULATOR ====================
    let isDrawing = false;
    const pixelColorInput = document.getElementById('pixel-color');

    function hexToRgb(hex) {
        const v = parseInt(hex.replace('#', ''), 16);
        return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    }

    function paintAtCanvasEvent(canvas, e) {
        stopSimAnim();
        updateNowPlayingBanner('🎨 手描きドット絵', 'キャンバス直接描画中', 'create:pixel');
        const rect = canvas.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const cx = (clientX - rect.left) * scaleX;
        const cy = (clientY - rect.top) * scaleY;

        const pad = 16;
        const cell = Math.max(2, Math.min((canvas.width - pad * 2) / simW, (canvas.height - pad * 2) / simH));
        const ox = (canvas.width - cell * simW) / 2;
        const oy = (canvas.height - cell * simH) / 2;

        const gx = Math.floor((cx - ox) / cell);
        const gy = Math.floor((cy - oy) / cell);
        if (gx >= 0 && gx < simW && gy >= 0 && gy < simH) {
            const [r, g, b] = hexToRgb(pixelColorInput.value);
            const p = (gy * simW + gx) * 3;
            frameBuffer[p] = r;
            frameBuffer[p + 1] = g;
            frameBuffer[p + 2] = b;
            drawSimulator();
        }
    }

    [simCanvas, mobCanvas].forEach(c => {
        c.addEventListener('mousedown', e => { isDrawing = true; paintAtCanvasEvent(c, e); });
        c.addEventListener('mousemove', e => { if (isDrawing) paintAtCanvasEvent(c, e); });
        window.addEventListener('mouseup', () => { isDrawing = false; });
        c.addEventListener('touchstart', e => { isDrawing = true; paintAtCanvasEvent(c, e); e.preventDefault(); }, { passive: false });
        c.addEventListener('touchmove', e => { if (isDrawing) paintAtCanvasEvent(c, e); e.preventDefault(); }, { passive: false });
        window.addEventListener('touchend', () => { isDrawing = false; });
    });

    document.querySelectorAll('.swatch').forEach(sw => {
        sw.addEventListener('click', () => { pixelColorInput.value = sw.dataset.color; });
    });

    document.getElementById('pixel-fill-btn').addEventListener('click', () => {
        stopSimAnim();
        const [r, g, b] = hexToRgb(pixelColorInput.value);
        for (let i = 0; i < frameBuffer.length; i += 3) {
            frameBuffer[i] = r; frameBuffer[i + 1] = g; frameBuffer[i + 2] = b;
        }
        updateNowPlayingBanner('🎨 手描きドット絵', `全面塗りつぶし (${pixelColorInput.value})`, 'create:pixel');
        drawSimulator();
    });

    document.getElementById('pixel-clear-btn').addEventListener('click', () => {
        stopSimAnim();
        frameBuffer.fill(0);
        updateNowPlayingBanner('🎨 手描きドット絵', '白紙キャンバス', 'create:pixel');
        drawSimulator();
    });

    function uint8ToBase64(u8) {
        let bin = '';
        for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
        return btoa(bin);
    }

    async function sendCurrentFrameToDevice() {
        await fetch('/api/live/frame', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                port: portSelect.value,
                width: simW,
                height: simH,
                raw_rgb: uint8ToBase64(frameBuffer)
            })
        });
    }

    document.getElementById('pixel-send-btn').addEventListener('click', sendCurrentFrameToDevice);

    document.getElementById('pixel-save-lib-btn').addEventListener('click', async () => {
        const b64 = uint8ToBase64(frameBuffer);
        const r = await fetch('/api/library/save_raw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: `手描きアート_${simW}x${simH}`,
                width: simW,
                height: simH,
                fps: 30,
                frames: Array(60).fill(b64)
            })
        });
        const d = await r.json();
        if (d.success) {
            await loadLibrary(false);
            await playLibraryItem(d.item, false);
            wfBtnSend.click();
        }
    });

    // ==================== TEXT MARQUEE (電光掲示板) ====================
    const offscreen = document.createElement('canvas');
    const offCtx = offscreen.getContext('2d');

    function generateMarqueeFrames(text, fgHex, bgHex) {
        offscreen.width = simW;
        offscreen.height = simH;
        const fontSize = Math.max(10, Math.round(simH * 0.72));
        offCtx.font = `bold ${fontSize}px "Inter", "Meiryo", sans-serif`;
        const textWidth = Math.ceil(offCtx.measureText(text).width);
        const totalSteps = simW + textWidth + 4;
        const frames = [];

        for (let step = 0; step < totalSteps; step += 1) {
            offCtx.fillStyle = bgHex;
            offCtx.fillRect(0, 0, simW, simH);
            offCtx.fillStyle = fgHex;
            offCtx.font = `bold ${fontSize}px "Inter", "Meiryo", sans-serif`;
            offCtx.textBaseline = 'middle';
            offCtx.fillText(text, simW - step, simH / 2);

            const imgData = offCtx.getImageData(0, 0, simW, simH).data;
            const rgb = new Uint8Array(simW * simH * 3);
            for (let i = 0, j = 0; i < imgData.length; i += 4, j += 3) {
                rgb[j] = imgData[i];
                rgb[j + 1] = imgData[i + 1];
                rgb[j + 2] = imgData[i + 2];
            }
            frames.push(rgb);
        }
        return frames;
    }

    function renderMarqueeFrame() {
        if (!libPlayFrames.length) return;
        const raw = libPlayFrames[libPlayIdx % libPlayFrames.length];
        if (raw.length === frameBuffer.length) frameBuffer.set(raw);
        libPlayIdx++;
    }

    document.getElementById('marquee-start-btn').addEventListener('click', () => {
        const text = document.getElementById('marquee-text').value || 'HELLO';
        const fg = document.getElementById('marquee-fg').value;
        const bg = document.getElementById('marquee-bg').value;
        libPlayFrames = generateMarqueeFrames(text, fg, bg);
        libPlayIdx = 0;
        startSimAnim('marquee');
        updateNowPlayingBanner('🔤 電光掲示板プレビュー中', `流れる文字: "${text}"`, 'create:marquee');
    });

    document.getElementById('marquee-stop-btn').addEventListener('click', stopAllStreams);

    document.getElementById('marquee-save-lib-btn').addEventListener('click', async () => {
        const text = document.getElementById('marquee-text').value || 'HELLO';
        const fg = document.getElementById('marquee-fg').value;
        const bg = document.getElementById('marquee-bg').value;
        const frames = generateMarqueeFrames(text, fg, bg);
        const r = await fetch('/api/library/save_raw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: `電光文字_${text.slice(0, 12)}`,
                width: simW,
                height: simH,
                fps: parseInt(document.getElementById('marquee-speed').value) || 30,
                frames: frames.map(uint8ToBase64)
            })
        });
        const d = await r.json();
        if (d.success) {
            await loadLibrary(false);
            await playLibraryItem(d.item, false);
            wfBtnSend.click();
        }
    });

    document.getElementById('mob-marquee-send-btn').addEventListener('click', () => {
        const text = document.getElementById('mob-marquee-text').value || 'HELLO';
        const fg = document.getElementById('mob-marquee-color').value;
        libPlayFrames = generateMarqueeFrames(text, fg, '#000000');
        libPlayIdx = 0;
        startSimAnim('marquee');
        updateNowPlayingBanner('🔤 スマホ電光掲示板', text, 'create:marquee');
    });

    // ==================== FX & QUICK DIAGNOSTICS ====================
    let selectedFx = 'rainbow';
    document.querySelectorAll('.fx-card').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.fx-card').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            selectedFx = btn.dataset.fx;
            startSimAnim(selectedFx);
            updateNowPlayingBanner('✨ エフェクト作成プレビュー', btn.textContent, `fx:${selectedFx}`);
        });
    });

    document.getElementById('fx-stream-btn').addEventListener('click', () => {
        startSimAnim(selectedFx);
        updateNowPlayingBanner('✨ エフェクト再生中', selectedFx.toUpperCase(), `fx:${selectedFx}`);
    });
    document.getElementById('fx-stop-btn').addEventListener('click', stopAllStreams);

    document.getElementById('fx-save-lib-btn').addEventListener('click', async () => {
        const saved = [];
        const prevMode = animMode;
        animMode = selectedFx;
        for (let i = 0; i < 90; i++) {
            stepProceduralFrame();
            saved.push(uint8ToBase64(frameBuffer));
        }
        animMode = prevMode;
        const r = await fetch('/api/library/save_raw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: `エフェクト_${selectedFx}_${simW}x${simH}`,
                width: simW,
                height: simH,
                fps: 30,
                frames: saved
            })
        });
        const d = await r.json();
        if (d.success) {
            await loadLibrary(false);
            await playLibraryItem(d.item, false);
            wfBtnSend.click();
        }
    });

    document.querySelectorAll('.qmode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.qmode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const m = parseInt(btn.dataset.tmode);
            document.getElementById('test-mode').value = m;
            stopSimAnim();

            const colorMap = {
                0: [0, 80, 255],
                1: [255, 255, 255],
                2: [0, 60, 255],
                3: [0, 255, 80],
                4: [255, 20, 40]
            };
            if (m === 9) {
                startSimAnim('rainbow');
                updateNowPlayingBanner('🧪 点灯テスト', '⑨ レインボー (Center Rainbow)', 'fx:rainbow');
            } else if (colorMap[m]) {
                const [r, g, b] = colorMap[m];
                for (let i = 0; i < frameBuffer.length; i += 3) {
                    frameBuffer[i] = r; frameBuffer[i + 1] = g; frameBuffer[i + 2] = b;
                }
                updateNowPlayingBanner('🧪 点灯テスト', btn.textContent, `test:${m}`);
                drawSimulator();
                sendCurrentFrameToDevice();
            }
        });
    });

    document.querySelectorAll('.mob-fx-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const fx = btn.dataset.fx;
            if (fx === 'blackout') {
                stopAllStreams();
                frameBuffer.fill(0);
                updateNowPlayingBanner('🌑 消灯', 'Blackout', 'none');
                drawSimulator();
                sendCurrentFrameToDevice();
            } else {
                startSimAnim(fx);
                updateNowPlayingBanner('✨ スマホエフェクト', fx.toUpperCase(), `fx:${fx}`);
            }
        });
    });

    document.getElementById('mob-solid-color').addEventListener('input', e => {
        stopSimAnim();
        const [r, g, b] = hexToRgb(e.target.value);
        for (let i = 0; i < frameBuffer.length; i += 3) {
            frameBuffer[i] = r; frameBuffer[i + 1] = g; frameBuffer[i + 2] = b;
        }
        updateNowPlayingBanner('🎨 単色カラー', e.target.value, 'solid');
        drawSimulator();
    });

    document.getElementById('mob-local-ledbin').addEventListener('change', async e => {
        const file = e.target.files[0];
        if (!file) return;
        const buf = new Uint8Array(await file.arrayBuffer());
        if (buf.length < 12 || String.fromCharCode(...buf.slice(0, 4)) !== 'DMO1') {
            alert('有効な .ledbin (DMO1) ファイルではありません。');
            return;
        }
        const w = buf[4] | (buf[5] << 8);
        const h = buf[6] | (buf[7] << 8);
        const clipCount = buf[9];
        const headerLen = 10 + 2 * clipCount;
        const frameBytes = w * h * 3;
        const frames = [];
        for (let off = headerLen; off + frameBytes <= buf.length; off += frameBytes) {
            frames.push(buf.slice(off, off + frameBytes));
        }
        if (frames.length) {
            libPlayW = w;
            libPlayH = h;
            libPlayFrames = frames;
            libPlayIdx = 0;
            startSimAnim('library');
            updateNowPlayingBanner('📁 ファイル再生', file.name, 'local_file');
        }
    });

    // ==================== INITIALIZATION ====================
    loadBoardsRegistry();
    loadLedSheets();
    renderChannels();
    scanPorts();
    // Auto-play the first saved clip in the library so it's immediately obvious what is playing!
    loadLibrary(true);
});
