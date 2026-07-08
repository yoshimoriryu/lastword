// All game-balance tunables live here. Server is authoritative; client only
// uses these for display hints.

export const PORT_DEFAULT = 3000;
export const MAX_PLAYERS = 6;

/** Bump when client/server protocol or game rules change — mismatched
 *  (usually cached) clients are told to hard-refresh instead of desyncing. */
export const PROTO_VERSION = 7;

export const MAX_ROOMS = 16;

/** Stack rows before top-out death. */
export const MAX_STACK = 16;

/**
 * Stack never drops below this — clears refill instantly from the shared
 * sequence (tetris piece-queue style), so fast typists are never idle.
 */
export const STACK_MIN = 5;

/** Neutral stream: interval(t) = max(MIN, START * e^(-t/TAU)) — t in seconds. */
export const NEUTRAL_START_INTERVAL_MS = 3000;
/** 300ms/word = ~200wpm just to keep up — the stream WILL end the match */
export const NEUTRAL_MIN_INTERVAL_MS = 300;
export const NEUTRAL_RAMP_TAU_S = 40;

/** Incoming attack words telegraph for this long before landing (counter window). */
export const ATTACK_LAND_DELAY_MS = 2000;

/** Streak breaks if no clear within this gap. */
export const STREAK_GAP_MS = 3000;

/** Speed-bonus baseline: slower than this per char = no bonus (~50 wpm). */
export const BASELINE_MS_PER_CHAR = 240;

/** Streak length at which surge starts charging. */
export const SURGE_MIN_STREAK = 3;

/** Surge meter cap — a full meter is one brutal burst, not an instakill. */
export const SURGE_MAX = 12;

/** Combo multiplier: 1 + STEP * min(streak, CAP). Defaults; modes override. */
export const COMBO_STEP = 0.08;
export const COMBO_CAP = 10;

/** Game modes — data-driven ruleset table. Adding a mode = adding an entry. */
export interface ModeRules {
  /** surge meter exists and fires on streak break */
  surge: boolean;
  /** Enter fires the surge manually */
  manualFire: boolean;
  comboStep: number;
  comboCap: number;
}

export const MODES = {
  surge: { surge: true, manualFire: true, comboStep: COMBO_STEP, comboCap: COMBO_CAP },
  "auto-surge": { surge: true, manualFire: false, comboStep: COMBO_STEP, comboCap: COMBO_CAP },
  // no surge — bigger combo ceiling rewards consistency instead (x2.5 at x15)
  classic: { surge: false, manualFire: false, comboStep: 0.1, comboCap: 15 },
} as const satisfies Record<string, ModeRules>;

export type ModeId = keyof typeof MODES;
export const DEFAULT_MODE: ModeId = "surge";

export const COUNTDOWN_MS = 3000;
export const TICK_MS = 50;

/** Bot difficulty presets: typing speed and per-keystroke error chance. */
export const BOT_PRESETS = {
  easy: { wpm: 25, err: 0.06 },
  medium: { wpm: 45, err: 0.04 },
  hard: { wpm: 70, err: 0.025 },
  insane: { wpm: 95, err: 0.015 },
} as const;

export const BOT_NAMES = ["typobot", "wordgoblin", "keysmash", "qwerty", "clanker"];

/**
 * Fractional attack value for one cleared word, before combo multiplier.
 * Accumulated server-side; whole words are sent when the accumulator crosses 1.
 * Tuned so a ~90wpm player sends ~1 word/s and a ~50wpm player ~0.4/s.
 */
export function attackValue(wordLen: number, tookMs: number): number {
  const baseline = wordLen * BASELINE_MS_PER_CHAR;
  const speedBonus = tookMs < baseline * 0.5 ? 0.35 : tookMs < baseline ? 0.15 : 0;
  return wordLen / 14 + speedBonus;
}

export function comboMult(streak: number, rules?: ModeRules): number {
  const step = rules?.comboStep ?? COMBO_STEP;
  const cap = rules?.comboCap ?? COMBO_CAP;
  return 1 + step * Math.min(streak, cap);
}

export function neutralIntervalMs(elapsedS: number): number {
  return Math.max(
    NEUTRAL_MIN_INTERVAL_MS,
    NEUTRAL_START_INTERVAL_MS * Math.exp(-elapsedS / NEUTRAL_RAMP_TAU_S),
  );
}

/** surge charge gained per clear while streak >= SURGE_MIN_STREAK */
export function surgeGain(streak: number): number {
  return 1 + Math.floor(streak / 6);
}
