# 各種 LED シート 仕様管理表 (LED Sheet Specifications)

> 本ファイルは Web UI の「📋 LEDシート仕様管理表」および `led_sheets_registry.json` と自動同期されます。

| 型番 / コード | シート名称 | 解像度 (W×H) | 総LED数 | 物理サイズ / ピッチ | LEDチップ (電圧/色順) | データピン構成 (トポロジー) | 配線仕様 (起点 / Zigzag) | 推奨輝度 | 用途・備考 |
|---|---|---:|---:|---|---|---|---|:---:|---|
| `SONY-LED-3624-A` | **36×24 標準フレキシブルLEDシート (Ver1.0実機検証済)** | **36×24** | 864灯 | 360mm × 240mm (10mmピッチ) | WS2812B (5V / GRB) | 1ピン [統合分割]<br><small>Ch1:GPIO2(36×24)</small> | Top-Left (左上) / Zigzag(蛇行) | 10 | TechHandsOn デモ機 / 汎用動画・テキスト表示用 |
| `SONY-LED-8810-S1` | **88×10 長尺リボンLEDマトリックス (Single)** | **88×10** | 880灯 | 880mm × 100mm (10mmピッチ) | WS2812B (5V / GRB) | 1ピン [統合分割]<br><small>Ch1:GPIO2(88×10)</small> | Top-Left (左上) / Zigzag(蛇行) | 10 | AudioLink Draft 標準バナー / 横長電光表示 |
| `SONY-LED-8810-D2` | **88×10 デュアルミラーLEDシート (2系統同時出力)** | **88×10** | 1760灯 | 880mm × 100mm × 2枚 | WS2812B (5V / GRB) | 2ピン [ミラー出力]<br><small>Ch1:GPIO2(88×10), Ch2:GPIO4(88×10)</small> | Top-Left (左上) / Zigzag(蛇行) | 10 | AudioLink 左右対称・2面同期演出 |
| `STD-WS-3208` | **32×8 汎用コンパクトLEDマトリックスシート** | **32×8** | 256灯 | 320mm × 80mm (10mmピッチ) | WS2812B (5V / GRB) | 1ピン [統合分割]<br><small>Ch1:GPIO2(32×8)</small> | Top-Left (左上) / Zigzag(蛇行) | 15 | 卓上テスト・小型電光掲示板・プロトタイプ検証用 |
| `STD-WS-1616` | **16×16 正方形ドット絵LEDパネル** | **16×16** | 256灯 | 160mm × 160mm (10mmピッチ) | WS2812B (5V / GRB) | 1ピン [統合分割]<br><small>Ch1:GPIO2(16×16)</small> | Top-Left (左上) / Zigzag(蛇行) | 15 | アイコン表示・ドット絵アート・小型サイン |
| `SONY-LED-7248-Q4` | **72×48 大型高精細マトリックス (4ピン並列分割駆動)** | **72×48** | 3456灯 | 720mm × 480mm (4ゾーン分割) | WS2812E (5V / GRB) | 4ピン [統合分割]<br><small>Ch1:GPIO2(72×12), Ch2:GPIO4(72×12), Ch3:GPIO5(72×12), Ch4:GPIO6(72×12)</small> | Top-Left (左上) / Zigzag(蛇行) | 8 | 大型展示・高フレームレート映像投影 (4Ch分割) |
