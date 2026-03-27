# ESP32 Hardware Tester & Manager

ESP32のハードウェア診断、MACアドレス確認、およびLEDマッピングテストを自動化するためのツールです。

## セットアップ

1.  **Python環境の準備**:
    ```bash
    pip install -r requirements.txt
    ```
2.  **PlatformIO Coreの準備**:
    `pio` コマンドがパスに通っている必要があります（VS CodeのPlatformIO拡張機能がインストールされていれば通常は利用可能です）。

## 使い方

### 1. デバイスの検出
接続されているESP32ポートを確認します。
```bash
python app.py scan
```

### 2. チップ情報の詳細・MACアドレス確認
特定のポート（例: COM3）のデバイス情報を表示します。
```bash
python app.py info COM3
```

### 3. テストファームウェアの書き込み（LEDマッピング設定）
LEDの数やピン番号を指定してテストプログラムを書き込みます。
```bash
python app.py deploy --port COM3 --width 88 --height 10 --pin 1
```

## ディレクトリ構成
- `app.py`: 管理ツール本体（Python）
- `src/main.cpp`: テスト用ファームウェア（C++/Arduino）
- `platformio.ini`: PlatformIO設定ファイル
