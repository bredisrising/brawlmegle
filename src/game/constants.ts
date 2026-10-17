import type { PlayerId } from '../types';

/** Simulation runs at a fixed step, independent of render framerate. */
export const SIM_DT = 1 / 60;

export const MAX_HP = 100;
export const COUNTDOWN_FROM = 3;
export const ROUND_SECONDS = 60;

/** World scale: every fighter is normalized to 1 meter tall. */
export const FIGHTER_HEIGHT = 1;
/** Fighters start this far apart on the fight line (meters). */
export const FIGHTER_SPACING = 1;

export const PLAYER_COLORS: Record<PlayerId, string> = {
  p1: '#ff3b5c',
  p2: '#2fb8ff',
};

export const PLAYER_NAMES: Record<PlayerId, string> = {
  p1: 'Player 1',
  p2: 'Player 2',
};

/** Extra freeze on K.O. (seconds). Normal hit-stop comes from FightEvent.hitstopFrames. */
export const KO_FREEZE = 0.5;
