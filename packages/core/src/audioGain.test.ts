import { describe, expect, it } from "vitest";
import {
  AUDIO_GAIN_FADER_MAX,
  AUDIO_GAIN_FADER_MIN,
  MAX_AUDIO_GAIN,
  audioGainToFaderPosition,
  audioGainToText,
  audioFaderPositionToGain,
} from "./audioGain";

describe("audio gain fader", () => {
  it("puts unity gain at the physical midpoint", () => {
    expect(audioGainToFaderPosition(1)).toBe(0);
    expect(audioFaderPositionToGain(0)).toBe(1);
  });

  it("provides +12 dB of boost above unity", () => {
    expect(audioFaderPositionToGain(AUDIO_GAIN_FADER_MAX)).toBeCloseTo(MAX_AUDIO_GAIN, 6);
    expect(audioGainToText(MAX_AUDIO_GAIN)).toBe("+12.0 dB");
  });

  it("preserves a true silence endpoint below unity", () => {
    expect(audioFaderPositionToGain(AUDIO_GAIN_FADER_MIN)).toBe(0);
    expect(audioGainToText(0)).toBe("-∞ dB");
  });

  it("pins sub-floor gain to the fader's silence endpoint", () => {
    expect(audioGainToFaderPosition(0.00001)).toBe(AUDIO_GAIN_FADER_MIN);
  });

  it("round-trips representative attenuation and boost values", () => {
    for (const gain of [0.1, 0.5, 1, 2, MAX_AUDIO_GAIN]) {
      expect(audioFaderPositionToGain(audioGainToFaderPosition(gain))).toBeCloseTo(gain, 6);
    }
  });
});
