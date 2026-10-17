export type PlayerId = 'p1' | 'p2';
export const PLAYER_IDS: readonly PlayerId[] = ['p1', 'p2'];

export const opponentOf = (id: PlayerId): PlayerId => (id === 'p1' ? 'p2' : 'p1');

export type Phase = 'lobby' | 'countdown' | 'fighting' | 'ko';

/** waiting -> scanning (camera/vision) -> forging (hero image + 3D model) -> ready */
export type PlayerStatus = 'waiting' | 'scanning' | 'forging' | 'ready';
