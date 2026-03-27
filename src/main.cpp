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
    
    // Zigzag assumes alternating physical data lines
    if (ZIGZAG && (ty % 2 != 0)) {
        tx = w - 1 - tx;
    }
    return (ty * w) + tx;
}

void setup() {
    Serial.begin(115200);
    delay(1000);

    Serial.println("\n--- ESP32 Hardware Tester (Enhanced) ---");
    Serial.printf("Strip A: Pin %d, %dx%d\n", STRIP_A_PIN, STRIP_A_WIDTH, STRIP_A_HEIGHT);
#ifdef DUAL_OUTPUT
    Serial.printf("Strip B: Pin %d, %dx%d\n", STRIP_B_PIN, STRIP_B_WIDTH, STRIP_B_HEIGHT);
#endif
    Serial.printf("Start Pos: %d, Test Mode: %d\n", START_POS, TEST_MODE);

    FastLED.addLeds<WS2812B, STRIP_A_PIN, LED_ORDER>(ledsA, NUM_LEDS_A);
#ifdef DUAL_OUTPUT
    FastLED.addLeds<WS2812B, STRIP_B_PIN, LED_ORDER>(ledsB, NUM_LEDS_B);
#endif

    FastLED.setBrightness(10); // User requested 10/255
    
    // --- Startup Boot Sequence (Applies to all modes on Reset/Power On) ---
    // 1. All Blue - Blink 3 times (Indicates physical reboot)
    for (int i = 0; i < 3; i++) {
        fill_solid(ledsA, NUM_LEDS_A, CRGB::Blue);
#ifdef DUAL_OUTPUT
        fill_solid(ledsB, NUM_LEDS_B, CRGB::Blue);
#endif
        FastLED.show();
        delay(300);
        FastLED.clear();
        FastLED.show();
        delay(300);
    }
}

void loop() {
    static uint8_t hue = 0;
    static uint32_t last_sparkle = 0;
    
    // State machine variables
    static unsigned long stateStartTime = millis();
    static int currentState = 0; 
    // State definitions:
    // 0: White (2s), 1: Red (2s), 2: Blue (2s), 3: Green (2s)
    // 4: Off (1s)
    // 5: Test Mode Animation (5s)
    // 6: Off (1s)

    // Override entirely for Test Mode 0 (Steady Blue)
    if (TEST_MODE == 0) {
        fill_solid(ledsA, NUM_LEDS_A, CRGB::Blue);
#ifdef DUAL_OUTPUT
        fill_solid(ledsB, NUM_LEDS_B, CRGB::Blue);
#endif
        FastLED.show();
        delay(20);
        return;
    }

    // Determine current state duration
    unsigned long currentDuration = 2000; // default 2s for colors
    if (currentState == 4 || currentState == 6) currentDuration = 1000;
    if (currentState == 5) currentDuration = 5000;

    // Advance state if duration exceeded
    if (millis() - stateStartTime >= currentDuration) {
        currentState++;
        if (currentState > 6) currentState = 0;
        stateStartTime = millis();
        // Reset FastLED canvas on state change
        FastLED.clear();
    }

    // Render logic based on current state
    if (currentState >= 0 && currentState <= 3) {
        CRGB sequenceColors[] = {CRGB::White, CRGB::Red, CRGB::Blue, CRGB::Green};
        fill_solid(ledsA, NUM_LEDS_A, sequenceColors[currentState]);
#ifdef DUAL_OUTPUT
        fill_solid(ledsB, NUM_LEDS_B, sequenceColors[currentState]);
#endif
    } 
    else if (currentState == 4 || currentState == 6) {
        FastLED.clear();
    } 
    else if (currentState == 5) {
        // Execute the chosen Test Mode animation
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
                // Rainbow from center
                float cx = (STRIP_A_WIDTH - 1) / 2.0;
                float cy = (STRIP_A_HEIGHT - 1) / 2.0;
                for(uint16_t y=0; y < STRIP_A_HEIGHT; y++) {
                    for(uint16_t x=0; x < STRIP_A_WIDTH; x++) {
                        float dist = sqrt(pow(x-cx, 2) + pow(y-cy, 2));
                        ledsA[getIndex(x,y, STRIP_A_WIDTH, STRIP_A_HEIGHT)] = CHSV(hue + (long)(dist * 20), 255, 255);
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
        
#ifdef DUAL_OUTPUT
        // Mirror Channel A to Channel B for all animations
        uint16_t max_copy = (NUM_LEDS_A < NUM_LEDS_B) ? NUM_LEDS_A : NUM_LEDS_B;
        for (uint16_t i = 0; i < max_copy; i++) {
            ledsB[i] = ledsA[i];
        }
#endif
        hue++; // progress animations
    }

    FastLED.show();
    delay(20);
}
