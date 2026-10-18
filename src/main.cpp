#include <Arduino.h>
#include <FastLED.h>

// --- Configuration (Overridden by build flags) ---
#ifndef STRIP_A_PIN
#define STRIP_A_PIN 2
#endif
#ifndef STRIP_A_WIDTH
#define STRIP_A_WIDTH 88
#endif
#ifndef STRIP_A_HEIGHT
#define STRIP_A_HEIGHT 10
#endif

#ifdef DUAL_OUTPUT
#ifndef STRIP_B_PIN
#define STRIP_B_PIN 4
#endif
#ifndef STRIP_B_WIDTH
#define STRIP_B_WIDTH 88
#endif
#ifndef STRIP_B_HEIGHT
#define STRIP_B_HEIGHT 10
#endif
#endif

#ifndef ZIGZAG
#define ZIGZAG 0
#endif

#ifndef START_POS
#define START_POS 0 // 0:TL, 1:TR, 2:BL, 3:BR
#endif

#ifndef TEST_MODE
#define TEST_MODE 9
#endif

#ifndef LED_ORDER
#define LED_ORDER GRB
#endif

#ifndef LED_BRIGHTNESS
#define LED_BRIGHTNESS 10
#endif

// --- Constants ---
#define NUM_LEDS_A (STRIP_A_WIDTH * STRIP_A_HEIGHT)
#ifdef DUAL_OUTPUT
#define NUM_LEDS_B (STRIP_B_WIDTH * STRIP_B_HEIGHT)
#else
#define NUM_LEDS_B 0
#endif

CRGB ledsA[NUM_LEDS_A];
#ifdef DUAL_OUTPUT
CRGB ledsB[NUM_LEDS_B];
#endif

// Global animation state
uint8_t hue = 0;
unsigned long last_sparkle = 0;

// Coordinate transformation based on START_POS
void getCoords(uint16_t x, uint16_t y, uint16_t w, uint16_t h, uint16_t &tx, uint16_t &ty) {
    switch (START_POS) {
        case 1: tx = w - 1 - x; ty = y; break;         // TR
        case 2: tx = x; ty = h - 1 - y; break;         // BL
        case 3: tx = w - 1 - x; ty = h - 1 - y; break; // BR
        default: tx = x; ty = y; break;                // TL
    }
}

// Mapping function for Zigzag + Start Position
uint16_t getIndex(uint16_t x, uint16_t y, uint16_t w, uint16_t h) {
    uint16_t tx, ty;
    getCoords(x, y, w, h, tx, ty);
    if (ZIGZAG && (ty % 2 != 0)) {
        tx = w - 1 - tx;
    }
    return (ty * w) + tx;
}

// --- Content mode (video frames over serial) ---
// Frame: AA 55 | W(2B,BE) | H(2B,BE) | RGB x (W*H), row-major from top-left | XOR checksum of payload
#ifndef CONTENT_TIMEOUT_MS
#define CONTENT_TIMEOUT_MS 2000
#endif
#ifndef SERIAL_BAUD
#define SERIAL_BAUD 921600
#endif

bool contentMode = false;
unsigned long lastFrameMs = 0;
static uint8_t rxBuf[NUM_LEDS_A * 3];
static uint8_t rxState = 0;       // 0:AA 1:55 2-5:W/H 6:payload 7:checksum
static uint8_t hdr[4];
static uint16_t rxLen = 0, rxPos = 0;
static uint8_t rxXor = 0;

void applyFrame() {
    for (uint16_t y = 0; y < STRIP_A_HEIGHT; y++) {
        for (uint16_t x = 0; x < STRIP_A_WIDTH; x++) {
            uint16_t p = (y * STRIP_A_WIDTH + x) * 3;
            ledsA[getIndex(x, y, STRIP_A_WIDTH, STRIP_A_HEIGHT)] = CRGB(rxBuf[p], rxBuf[p + 1], rxBuf[p + 2]);
        }
    }
}

void processSerial() {
    while (Serial.available()) {
        uint8_t b = Serial.read();
        switch (rxState) {
            case 0: if (b == 0xAA) rxState = 1; break;
            case 1: rxState = (b == 0x55) ? 2 : (b == 0xAA ? 1 : 0); break;
            case 2: case 3: case 4: case 5:
                hdr[rxState - 2] = b;
                rxState++;
                if (rxState == 6) {
                    uint16_t w = (hdr[0] << 8) | hdr[1];
                    uint16_t h = (hdr[2] << 8) | hdr[3];
                    if (w != STRIP_A_WIDTH || h != STRIP_A_HEIGHT) { rxState = 0; break; } // size mismatch
                    rxLen = NUM_LEDS_A * 3; rxPos = 0; rxXor = 0;
                }
                break;
            case 6:
                rxBuf[rxPos++] = b; rxXor ^= b;
                if (rxPos >= rxLen) rxState = 7;
                break;
            case 7:
                if (b == rxXor) {
                    applyFrame();
                    contentMode = true;
                    lastFrameMs = millis();
                }
                rxState = 0;
                break;
        }
    }
    if (contentMode && millis() - lastFrameMs > CONTENT_TIMEOUT_MS) {
        contentMode = false;   // back to demo
        FastLED.clear();
    }
}

// --- Demo clips (embedded in flash by board_build.embed_files, see demo_builder.py) ---
// Blob: 'DMO1' | u16 W | u16 H | u8 fps | u8 clipCount | u16 frames[clipCount] | RGB frames...
#ifndef DEMO_FADE_MS
#define DEMO_FADE_MS 800
#endif
#define MAX_CLIPS 16
extern const uint8_t demoBlob[] asm("_binary_demo_clips_bin_start");

static uint8_t clipCount = 0;
static uint8_t clipFps = 30;
static uint16_t clipFrames[MAX_CLIPS];
static const uint8_t* clipData[MAX_CLIPS];

void initClips() {
    const uint8_t* p = demoBlob;
    if (memcmp(p, "DMO1", 4) != 0) return;
    uint16_t w = p[4] | (p[5] << 8);
    uint16_t h = p[6] | (p[7] << 8);
    clipFps = p[8];
    uint8_t n = p[9];
    if (n == 0 || n > MAX_CLIPS || clipFps == 0) return;
    if (w != STRIP_A_WIDTH || h != STRIP_A_HEIGHT) {
        Serial.printf("Demo clips ignored: size %dx%d != %dx%d\n", w, h, STRIP_A_WIDTH, STRIP_A_HEIGHT);
        return;
    }
    const uint8_t* data = p + 10 + 2 * n;
    for (uint8_t i = 0; i < n; i++) {
        clipFrames[i] = p[10 + 2 * i] | (p[11 + 2 * i] << 8);
        clipData[i] = data;
        data += (uint32_t)clipFrames[i] * NUM_LEDS_A * 3;
    }
    clipCount = n;
}

unsigned long clipDurationMs(uint8_t i) {
    return (unsigned long)clipFrames[i] * 1000UL / clipFps;
}

// Render clip i at 'elapsed' ms, with fade-in at the start and fade-out at the end
void renderClip(uint8_t i, unsigned long elapsed) {
    unsigned long total = clipDurationMs(i);
    uint32_t f = elapsed * clipFps / 1000;
    if (f >= clipFrames[i]) f = clipFrames[i] - 1;
    uint8_t s = 255;
    if (elapsed < DEMO_FADE_MS) s = elapsed * 255UL / DEMO_FADE_MS;
    else if (total > elapsed && total - elapsed < DEMO_FADE_MS) s = (total - elapsed) * 255UL / DEMO_FADE_MS;
    const uint8_t* fr = clipData[i] + f * NUM_LEDS_A * 3;
    for (uint16_t y = 0; y < STRIP_A_HEIGHT; y++) {
        for (uint16_t x = 0; x < STRIP_A_WIDTH; x++) {
            const uint8_t* px = fr + (y * STRIP_A_WIDTH + x) * 3;
            ledsA[getIndex(x, y, STRIP_A_WIDTH, STRIP_A_HEIGHT)] =
                CRGB(scale8(px[0], s), scale8(px[1], s), scale8(px[2], s));
        }
    }
}

void setup() {
    Serial.setRxBufferSize(4096);
    Serial.begin(SERIAL_BAUD);
    delay(1000);

    Serial.println("\n--- ESP32 Hardware Tester (Enhanced) ---");
    Serial.printf("Strip A: Pin %d\n", STRIP_A_PIN);
    Serial.printf("Size: %dx%d, Mode: %d\n", STRIP_A_WIDTH, STRIP_A_HEIGHT, TEST_MODE);

    FastLED.addLeds<WS2812B, STRIP_A_PIN, LED_ORDER>(ledsA, NUM_LEDS_A);
#ifdef DUAL_OUTPUT
    FastLED.addLeds<WS2812B, STRIP_B_PIN, LED_ORDER>(ledsB, NUM_LEDS_B);
#endif

    FastLED.setBrightness(LED_BRIGHTNESS);
    initClips();
    Serial.printf("Demo clips: %d\n", clipCount);
}

void loop() {
    static unsigned long stateStartTime = millis();
    // If demo clips are embedded, the demo plays only the clips (states 16+).
    // Without clips, the legacy pattern sequence (states 0-15) is the fallback.
    const int firstState = clipCount ? 16 : 0;
    static int currentState = clipCount ? 16 : 0; 
    const int numStates = 16 + clipCount;
    
    processSerial();

    if (contentMode) {
        // LEDs already updated from the received frame
    }
    // Override for Test Mode 0 (Steady Blue)
    else if (TEST_MODE == 0) {
        fill_solid(ledsA, NUM_LEDS_A, CRGB::Blue);
    } 
    else {
        // Determine current state duration
        unsigned long currentDuration = 1500; // Default for scans
        if (currentState == 6 || currentState == 9 || currentState == 12) currentDuration = 2000; // Solids
        else if (currentState == 13 || currentState == 15) currentDuration = 1000; // Offs
        else if (currentState == 14) currentDuration = 5000; // Test Mode (selected by user)
        else if (currentState >= 16) currentDuration = clipDurationMs(currentState - 16); // Demo clips
        
        // Advance state if duration exceeded
        if (millis() - stateStartTime >= currentDuration) {
            currentState++;
            if (currentState >= numStates) currentState = firstState;
            stateStartTime = millis();
            FastLED.clear();
        }

        // Render logic
        if (currentState <= 12) {
            // --- Scan and Solid States (0-12) ---
            CRGB color = CRGB::Black;
            uint16_t lineWidth = 0; // 0 means Solid
            bool leftToRight = false;

            if (currentState <= 3) {
                color = CRGB::White;
                lineWidth = (currentState >= 2) ? 5 : 1;
                leftToRight = (currentState % 2 != 0); 
            } else if (currentState <= 6) {
                color = CRGB::Blue;
                lineWidth = (currentState == 6) ? 0 : 5;
                leftToRight = (currentState == 5);     
            } else if (currentState <= 9) {
                color = CRGB::Red;
                lineWidth = (currentState == 9) ? 0 : 5;
                leftToRight = (currentState == 8);     
            } else if (currentState <= 12) {
                color = CRGB::Green;
                lineWidth = (currentState == 12) ? 0 : 5;
                leftToRight = (currentState == 11);    
            }

            if (lineWidth == 0) {
                fill_solid(ledsA, NUM_LEDS_A, color);
            } else {
                float progress = (float)(millis() - stateStartTime) / 1500.0f;
                if (progress > 1.0f) progress = 1.0f;
                float totalRange = (float)STRIP_A_WIDTH + lineWidth;
                float currentOffset = leftToRight ? (progress * totalRange - lineWidth) : ((1.0f - progress) * totalRange - lineWidth);

                FastLED.clear();
                for (uint16_t iy = 0; iy < STRIP_A_HEIGHT; iy++) {
                    for (uint16_t ix = 0; ix < STRIP_A_WIDTH; ix++) {
                        if (ix >= currentOffset && ix < currentOffset + lineWidth) {
                            ledsA[getIndex(ix, iy, STRIP_A_WIDTH, STRIP_A_HEIGHT)] = color;
                        }
                    }
                }
            }
        } 
        else if (currentState >= 16) {
            // --- Demo clips (fade in/out) ---
            renderClip(currentState - 16, millis() - stateStartTime);
        }
        else if (currentState == 13 || currentState == 15) {
            FastLED.clear();
        } 
        else if (currentState == 14) {
            // --- User Selected Test Mode ---
            CRGB color = CRGB::Black;
            bool sparkle = false;
            FastLED.clear();

            switch (TEST_MODE) {
                case 1: color = CRGB::White; break;
                case 2: color = CRGB::Blue; break;
                case 3: color = CRGB::Green; break;
                case 4: color = CRGB::Red; break;
                case 5: color = CRGB::White; sparkle = true; break;
                case 6: color = CRGB::Blue; sparkle = true; break;
                case 7: color = CRGB::Green; sparkle = true; break;
                case 8: color = CRGB::Red; sparkle = true; break;
                case 9:
                default:
                    // Smooth Rainbow from center
                    uint8_t baseHue = beat8(15); 
                    float cx = (STRIP_A_WIDTH - 1) / 2.0f;
                    float cy = (STRIP_A_HEIGHT - 1) / 2.0f;
                    float maxDist = sqrt(cx*cx + cy*cy);
                    for(uint16_t y=0; y < STRIP_A_HEIGHT; y++) {
                        for(uint16_t x=0; x < STRIP_A_WIDTH; x++) {
                            float dist = sqrt(pow(x-cx, 2) + pow(y-cy, 2));
                            uint8_t h = baseHue + (uint8_t)((dist / maxDist) * 160);
                            ledsA[getIndex(x, y, STRIP_A_WIDTH, STRIP_A_HEIGHT)] = CHSV(h, 245, 255);
                        }
                    }
                    break;
            }

            if (TEST_MODE >= 1 && TEST_MODE <= 8) {
                fill_solid(ledsA, NUM_LEDS_A, color);
                if (sparkle) {
                    if (millis() - last_sparkle > 50) {
                        for(int i=0; i<NUM_LEDS_A/10; i++) {
                            ledsA[random16(NUM_LEDS_A)] = CRGB::Black;
                        }
                        last_sparkle = millis();
                    }
                }
            }
        }
    }

#ifdef DUAL_OUTPUT
    // Mirror Channel A to Channel B
    uint16_t max_copy = (NUM_LEDS_A < NUM_LEDS_B) ? NUM_LEDS_A : NUM_LEDS_B;
    for (uint16_t i = 0; i < max_copy; i++) {
        ledsB[i] = ledsA[i];
    }
#endif

    FastLED.show();
    delay(contentMode ? 2 : 33); // content: poll serial often; demo: ~30 FPS
}
