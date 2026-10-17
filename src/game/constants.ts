import type { PlayerId } from '../types';

/** Simulation runs at a fixed step, independent of render framerate. */
export const SIM_DT = 1 / 60;

export const MAX_HP = 100;
export const COUNTDOWN_FROM = 3;

/** World scale: every fighter is normalized to 1 meter tall. */
export const FIGHTER_HEIGHT = 1;
/** Distance between the two fighters along the x axis. */
export const FIGHTER_SPACING = 0.6;

export const PLAYER_COLORS: Record<PlayerId, string> = {
  p1: '#ff3b5c',
  p2: '#2fb8ff',
};

export const PLAYER_NAMES: Record<PlayerId, string> = {
  p1: 'Player 1',
  p2: 'Player 2',
};

/** Freeze-frame durations (seconds) per hit kind. */
export const HITSTOP = { light: 0.06, heavy: 0.14, blocked: 0.04, ko: 0.5 };
