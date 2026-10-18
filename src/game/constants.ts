import type { PlayerId } from '../types';

/** Simulation runs at a fixed step, independent of render framerate. */
export const SIM_DT = 1 / 60;

export const MAX_HP = 100;
/** The round-start beats: 2 = the walkout (fighter entrances), 1 = ROUND 1, 0 = FIGHT. */
export const COUNTDOWN_FROM = 2;
export const ROUND_SECONDS = 60;

/** World scale: every fighter is normalized to 1 meter tall. */
export const FIGHTER_HEIGHT = 1;
/** Display-only scale applied to each fighter on screen. Models, poses and the fight line stay in 1 m units. */
export const FIGHTER_SCALE = 0.75;
/**
 * Screen meters per fight-line meter. The engine's ranges are tuned for play, not anatomy, so the director draws
 * the fight line shorter: fighters stand close enough that a punch in range visibly reaches.
 */
export const FIGHT_LINE_SCALE = 0.5;
/** Fighters start this far apart on the fight line (meters). */
export const FIGHTER_SPACING = 1;

export const PLAYER_COLORS: Record<PlayerId, string> = {
  p1: '#ff2d95',
  p2: '#1f8bff',
};

export const PLAYER_NAMES: Record<PlayerId, string> = {
  p1: 'Player 1',
  p2: 'Player 2',
};

/** Extra freeze on K.O. (seconds). Normal hit-stop comes from FightEvent.hitstopFrames. */
export const KO_FREEZE = 0.5;
