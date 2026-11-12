/**
 * Sarvam voice settings shared by the app and the site's Sarvam route. The route only lets a
 * live connection (WebSocket) through with exactly these models and audio settings, so the
 * owner's key can't be used for other Sarvam services.
 */
export const TTS_MODEL = 'bulbul:v3';
export const STT_REALTIME_MODEL = 'saaras:v3-realtime';
export const STT_REALTIME_SAMPLE_RATE = 16_000;

/** Live-connection paths under /api/sarvam/, the same as on api.sarvam.ai. */
export const SARVAM_TTS_STREAM_PATH = 'text-to-speech/ws';
export const SARVAM_STT_STREAM_PATH = 'speech-to-text-realtime/ws';
