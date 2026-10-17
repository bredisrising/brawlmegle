import { create } from 'zustand';
import { PLAYER_IDS, type Phase, type PlayerId, type PlayerStatus, type Role } from '../types';
import { MAX_HP, PLAYER_NAMES } from './constants';

/** Popup style. Game maps FightEvents onto these. */
export type HitKind = 'light' | 'heavy' | 'blocked';

export interface PlayerState {
  name: string;
  status: PlayerStatus;
  /** Human-readable step while scanning/forging. */
  statusDetail: string;
  hp: number;
  /** Generated hero portrait (from the forge pipeline), shown in the HUD. */
  portraitUrl: string | null;
}

export interface HitPopup {
  id: number;
  x: number;
  y: number;
  label: string;
  damage: number;
  kind: HitKind;
}

/**
 * App-level screens (before/around the fight):
 *   title -> avatar (scan new / choose existing) -> game (host) | client (client laptop)
 */
export type Screen = 'title' | 'avatar' | 'game' | 'client';

/** UI-facing state. The Game writes to it; React components read from it. */
export interface GameState {
  screen: Screen;
  role: Role | null;
  /** Room code from the signaling server (host shows it, client typed it). */
  roomCode: string | null;
  phase: Phase;
  /** 3, 2, 1, then 0 = "FIGHT!"; null when hidden. */
  countdown: number | null;
  winner: PlayerId | null;
  players: Record<PlayerId, PlayerState>;
  popups: HitPopup[];
  /** Bumped on big hits to retrigger the screen-flash animation. */
  flashKey: number;
}

const initialPlayer = (id: PlayerId): PlayerState => ({
  name: PLAYER_NAMES[id],
  status: 'waiting',
  statusDetail: '',
  hp: MAX_HP,
  portraitUrl: null,
});

export const useGameStore = create<GameState>(() => ({
  screen: 'title',
  role: null,
  roomCode: null,
  phase: 'lobby',
  countdown: null,
  winner: null,
  players: Object.fromEntries(PLAYER_IDS.map((id) => [id, initialPlayer(id)])) as Record<PlayerId, PlayerState>,
  popups: [],
  flashKey: 0,
}));

/** The player slot tracked on this laptop: host = p1, client = p2. */
export const localPlayerId = (role: Role | null): PlayerId => (role === 'client' ? 'p2' : 'p1');

export const updatePlayer = (id: PlayerId, patch: Partial<PlayerState>) =>
  useGameStore.setState((s) => ({ players: { ...s.players, [id]: { ...s.players[id], ...patch } } }));

let popupId = 0;
export const pushPopup = (popup: Omit<HitPopup, 'id'>) =>
  useGameStore.setState((s) => ({ popups: [...s.popups, { ...popup, id: ++popupId }] }));

export const removePopup = (id: number) =>
  useGameStore.setState((s) => ({ popups: s.popups.filter((p) => p.id !== id) }));
