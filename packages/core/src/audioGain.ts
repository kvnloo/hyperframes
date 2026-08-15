/**
 * Authoring gain for a media clip.
 *
 * HTMLMediaElement.volume is limited to 0..1, but HyperFrames' Web Audio
 * preview and FFmpeg render paths both support gain above unity. Keep the
 * shared ceiling here so Studio, preview, and render cannot drift.
 */
export const MAX_AUDIO_GAIN_DB = 12;
export const MAX_AUDIO_GAIN = 10 ** (MAX_AUDIO_GAIN_DB / 20);

/** Studio fader coordinates. Unity is deliberately the physical midpoint. */
export const AUDIO_GAIN_FADER_MIN = -100;
export const AUDIO_GAIN_FADER_MAX = 100;

const MIN_AUDIO_GAIN_DB = -60;

export function clampAudioGain(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(MAX_AUDIO_GAIN, value));
}

export function clampNativeMediaVolume(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

export function audioFaderPositionToGain(position: number): number {
  const safe = Math.max(AUDIO_GAIN_FADER_MIN, Math.min(AUDIO_GAIN_FADER_MAX, position));
  if (safe === AUDIO_GAIN_FADER_MIN) return 0;
  const db =
    safe < 0
      ? (safe / Math.abs(AUDIO_GAIN_FADER_MIN)) * Math.abs(MIN_AUDIO_GAIN_DB)
      : (safe / AUDIO_GAIN_FADER_MAX) * MAX_AUDIO_GAIN_DB;
  return 10 ** (db / 20);
}

export function audioGainToFaderPosition(gain: number): number {
  const safe = clampAudioGain(gain);
  if (safe === 0) return AUDIO_GAIN_FADER_MIN;
  const db = 20 * Math.log10(safe);
  const position =
    db < 0
      ? (db / Math.abs(MIN_AUDIO_GAIN_DB)) * Math.abs(AUDIO_GAIN_FADER_MIN)
      : (db / MAX_AUDIO_GAIN_DB) * AUDIO_GAIN_FADER_MAX;
  return Math.max(AUDIO_GAIN_FADER_MIN, Math.min(AUDIO_GAIN_FADER_MAX, position));
}

export function audioGainToText(gain: number): string {
  const safe = clampAudioGain(gain);
  if (safe === 0) return "-∞ dB";
  const db = 20 * Math.log10(safe);
  const rounded = Math.abs(db) < 0.05 ? 0 : db;
  return (rounded > 0 ? "+" : "") + rounded.toFixed(1) + " dB";
}
