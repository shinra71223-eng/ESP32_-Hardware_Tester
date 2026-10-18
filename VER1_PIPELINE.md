# ESP32 Hardware Tester Ver1.0 パイプライン概要

本ドキュメントは **Ver1.0** におけるシステム全体のデータフロー、処理パイプライン、およびステートマシン構成をまとめた設計図です。

---

## 1. システム全体アーキテクチャ

システムは大きく **PC側（Python / Flask GUI / OpenCV）** と **ESP32側（C++ / Arduino / FastLED）** の2つの層で構成されています。

```mermaid
graph TB
    subgraph PC_App ["PC アプリケーション (GUI: server.py / HTML+JS)"]
        UI["Web UI ブラウザ操作<br/>(http://127.0.0.1:5000)"]
        InfoEngine["ESP32 検出 & チップ診断<br/>(esptool: 4MB / 8MB Flash判定)"]
        DeployEngine["ファームウェア生成 & 書き込み<br/>(demo_builder.py + PlatformIO CLI)"]
        LiveStreamEngine["リアルタイム動画送信エンジン<br/>(OpenCV + PySerial @ 921,600 bps)"]
    end

    subgraph ESP32_FW ["ESP32-S3 ファームウェア (main.cpp)"]
        RxSM["Serial 受信ステートマシン<br/>(AA 55 W H RGB... XOR)"]
        ModeSwitch{"動作モード判定<br/>(lastFrameMs < 2000ms)"}
        ContentPlayback["コンテンツ再生処理<br/>(受信フレーム直接描画)"]
        DemoPlayback["デモ再生処理<br/>(内蔵 Flash 動画 + フェードイン/アウト)"]
        MappingEngine["LEDマッピング変換<br/>(getIndex: ZIGZAG & START_POS)"]
        FastLEDDriver["FastLED 出力 (GPIO)<br/>WS2812B 信号送信"]
    end

    UI --> InfoEngine
    UI --> DeployEngine
    UI --> LiveStreamEngine

    DeployEngine -- "USB 書き込み (pio upload)" --> ESP32_FW
    LiveStreamEngine -- "USB CDC シリアルストリーム" --> RxSM

    RxSM --> ModeSwitch
    ModeSwitch -- "フレーム受信中" --> ContentPlayback
    ModeSwitch -- "2秒無受信 / 待機時" --> DemoPlayback

    ContentPlayback --> MappingEngine
    DemoPlayback --> MappingEngine
    MappingEngine --> FastLEDDriver
```

---

## 2. パイプライン A: デモ動画内蔵 & FWビルド・デプロイ

PC上で選択した複数動画を LED 解像度にリサンプル・変換し、ファームウェアと一緒に大容量アプリ領域にフラッシュ書き込みする流れです。

```mermaid
sequenceDiagram
    autonumber
    actor User as ユーザー
    participant UI as Web UI (ブラウザ)
    participant Server as Flask Server (server.py)
    participant Builder as demo_builder.py
    participant PIO as PlatformIO / esptool
    participant ESP32 as ESP32-S3 Flash

    User->>UI: 1. ポート選択 & 「Info」ボタン押下
    UI->>Server: /api/info?port=COMx
    Server->>PIO: esptool flash-id
    PIO-->>Server: チップ種別 / Flash容量(4MB or 8MB)
    Server-->>UI: 検出結果表示 (esp32s3_4mb / esp32s3_8mb)

    User->>UI: 2. LEDサイズ(36x24), 動画パス(3本), フェード時間(ms) 設定
    User->>UI: 3. 「Deploy Firmware」クリック
    UI->>Server: POST /api/deploy (NDJSON ストリーム)

    rect rgb(240, 248, 255)
        Note over Server,Builder: デモ動画の事前変換 (demo_builder)
        Server->>Builder: build_blob(paths, 36, 24, fit="crop", fps=30)
        Builder->>Builder: OpenCVフレーム読込 & 中央トリミング/リサイズ
        Builder->>Builder: DMO1バイナリ生成 (demo/clips.bin)
    end

    rect rgb(255, 250, 240)
        Note over Server,PIO: 大容量パーティション適用 & ビルド
        Server->>PIO: pio run -e esp32s3_4mb (or 8mb) --target upload
        Note over PIO: board_build.embed_files = demo/clips.bin
        Note over PIO: partitions_4MB_demo.csv (約3.9MB App領域)
        PIO->>ESP32: ブートローダ + ファームウェア + 内蔵動画Blob 書き込み
    end

    PIO-->>Server: Upload Success
    Server-->>UI: DEPLOYMENT SUCCESSFUL
    UI-->>User: 書き込み完了通知
```

---

## 3. パイプライン B: コンテンツ再生モード (PCライブストリーミング)

PC上で動画を再生しながらフレーム単位で RGB パケットをシリアル送信し、リアルタイムにマトリックスに投影する流れです。

```mermaid
sequenceDiagram
    autonumber
    actor User as ユーザー
    participant UI as Web UI
    participant Server as Flask Server (_send_worker)
    participant ESP32 as ESP32-S3 (main.cpp)
    participant LED as LED マトリックス (36x24)

    User->>UI: 動画ファイル選択 & プレビュー確認 (OK チェック)
    User->>UI: 「送信 (Send)」ボタン押下
    UI->>Server: POST /api/video/send (port, 36, 24, crop, loop, fps)
    
    Server->>Server: 送信ワーカースレッド起動 / ポートオープン (921,600bps)
    
    loop 各フレーム (30 FPS 周期: 約33msごと)
        Server->>Server: OpenCV frame 取得 & 36x24 トリミング
        Server->>Server: パケット生成: [0xAA, 0x55, W(2B), H(2B), RGB(2592B), XOR_CHK]
        Server->>ESP32: シリアルデータ送信 (約2.6KB)
        ESP32->>ESP32: processSerial(): ヘッダ検出 & XOR検証
        ESP32->>ESP32: contentMode = true, lastFrameMs = millis()
        ESP32->>LED: FastLED.show() (リアルタイム表示)
    end

    User->>UI: 「停止 (Stop)」クリック
    UI->>Server: POST /api/video/stop
    Server->>Server: スレッド停止 & シリアルポート解放

    rect rgb(255, 240, 245)
        Note over ESP32,LED: 自動デモ復帰処理
        ESP32->>ESP32: millis() - lastFrameMs > 2000ms 判定
        ESP32->>ESP32: contentMode = false (DEMOモードに自動復帰)
        ESP32->>LED: 内蔵デモ動画のループ再生を再開 (フェードイン)
    end
```

---

## 4. ESP32 内部ステートマシン構成 (main.cpp)

ESP32 は起動直後から自律的に以下のステートマシンを実行します。

```mermaid
stateDiagram-v2
    [*] --> Initialize: 電源ON / リセット
    Initialize --> DemoMode: FastLED初期化 & initClips() 読込

    state DemoMode {
        [*] --> Clip1: キラキラ3
        Clip1 --> Clip2: フェードアウト → イン (デジタル背景２)
        Clip2 --> Clip3: フェードアウト → イン (ハイパーメディア２)
        Clip3 --> Clip1: ループ
    }

    state ContentMode {
        ReceiveFrame: 受信フレームを ledsA に即時反映
        FastShow: FastLED.show() (ディレイ 2ms でポーリング)
    }

    DemoMode --> ContentMode: 有効なフレームパケットを受信 (0xAA 0x55...)
    ContentMode --> ContentMode: 後続フレーム受信継続
    ContentMode --> DemoMode: 最後の受信から 2000ms 経過 (タイムアウト)
```

---

## 5. 主要データプロトコル仕様

### ① デモ動画 Blob フォーマット (`demo/clips.bin`)
Flashメモリ上に静的に配置されるバイナリ構造：

| オフセット | サイズ | 型 / 値 | 説明 |
|---|---|---|---|
| `0x00` | 4B | ASCII `"DMO1"` | マジック識別子 |
| `0x04` | 2B | uint16 (Little-Endian) | 幅 $W$ (例: 36) |
| `0x06` | 2B | uint16 (Little-Endian) | 高さ $H$ (例: 24) |
| `0x08` | 1B | uint8 | フレームレート (30 fps) |
| `0x09` | 1B | uint8 | 収録クリップ数 $N$ (例: 3) |
| `0x0A` | $2N$ B | uint16 × $N$ | 各クリップのフレーム数リスト |
| その後 | 可変 | RGBバイト列 ($W \times H \times 3$) | 行順 (Top-Left起点) のRAW RGBデータ |

### ② ライブストリーミング パケットフォーマット (Serial)
PCからESP32へUSBシリアル経由で送られる1フレーム分の構造：

| バイト位置 | サイズ | 値 / 内容 | 説明 |
|---|---|---|---|
| 0〜1 | 2B | `0xAA 0x55` | フレーム開始プリアンブル |
| 2〜3 | 2B | uint16 (Big-Endian) | 幅 $W$ (例: 36) |
| 4〜5 | 2B | uint16 (Big-Endian) | 高さ $H$ (例: 24) |
| 6〜 ($6+W \times H \times 3 - 1$) | $W \times H \times 3$ B | uint8 RGB配列 | 各画素のRGB値 (36×24の場合 2,592バイト) |
| 末尾 | 1B | XOR Checksum | ペイロード全バイトの累積 XOR 値 |
