/**
 * Shared contracts between modules (see SPEC.md "Module contracts").
 * Agree on these first so everyone can build in parallel against mocks.
 */

export type PlayerId = 'p1' | 'p2';
export const PLAYER_IDS: readonly PlayerId[] = ['p1', 'p2'];

export const opponentOf = (id: PlayerId): PlayerId => (id === 'p1' ? 'p2' : 'p1');

/** Which laptop this is. Host = the game + P1, client = scanner/streamer for P2. */
export type Role = 'host' | 'client';

export type Phase = 'lobby' | 'countdown' | 'fighting' | 'ko';

/** waiting -> scanning (camera/vision) -> forging (hero image + 3D model) -> ready */
export type PlayerStatus = 'waiting' | 'scanning' | 'forging' | 'ready';

// ---------------------------------------------------------------------------
// Input: any source (local camera, remote peer, mock, replay) -> InputHub
// ---------------------------------------------------------------------------

export type Landmark = { x: number; y: number; z: number; visibility: number };

/** One tracked frame of one person, ~30 fps. Sources don't know which player they are; the InputHub tags them. */
export type PoseFrame = {
  t: number; // performance.now() in ms, on the machine that tracked it
  image: Landmark[]; // 33 MediaPipe landmarks, normalized image coords
  world: Landmark[]; // 33 world landmarks, meters, hip-centered
  aspect?: number; // video width / height. Image x and y are normalized separately, so distances need it.
};

// ---------------------------------------------------------------------------
// Intent -> Fight engine
// ---------------------------------------------------------------------------

export type Hand = 'L' | 'R';
export type AttackMove = 'jab' | 'cross' | 'hook' | 'uppercut' | 'knee' | 'kick' | 'fireball';
export type DefendMove = 'block' | 'slip' | 'duck';

export type Command =
  | { kind: 'anticipate'; player: PlayerId; t: number; hand: Hand }
  | {
      kind: 'attack';
      player: PlayerId;
      t: number;
      move: AttackMove;
      hand: Hand;
      height: 'head' | 'body';
      speed: number; // 0.8–1.3, relative to this player's calibrated max
      windup: number; // 0.8–1.3
      lunge?: number; // meters to step in during startup (the resolver adds it when the strike starts out of range)
      autoLunge?: boolean; // instead: step in as far as needed when it actually starts (queued combo punches)
      headStart?: number; // frames the wind-up has already been on screen (the reader saw the motion start that long ago)
    }
  | { kind: 'defend'; player: PlayerId; t: number; move: DefendMove; dir?: Hand };

/** Continuous, every frame. */
export type Stance = {
  player: PlayerId;
  guard: boolean;
  advance: number; // -1 (backing off) to 1 (stepping in)
  lean: { x: number; y: number };
  tracked: boolean; // false when the player is lost
};

// ---------------------------------------------------------------------------
// Fight engine -> Director / UI / Commentary
// ---------------------------------------------------------------------------

export type FighterState = {
  x: number; // position on the fight line, meters
  hp: number;
  stamina: number;
  phase: 'idle' | 'startup' | 'active' | 'recovery' | 'hitstun' | 'blockstun' | 'ko';
  move?: string;
  frame: number; // frame within the current phase
  // For the director (how to draw it), not the rules:
  hand?: Hand; // the attacking hand (or leg, for knees and kicks)
  height?: 'head' | 'body';
  length?: number; // total frames of the current phase, when it has a fixed length
  evade?: 'slip' | 'duck';
  evadeDir?: Hand;
  /** Super meter, 0..FIGHT.maxMeter: a full one throws a fireball. */
  meter?: number;
};

/** A fireball in flight, for the director. */
export type Projectile = { id: number; owner: PlayerId; x: number };

export type FightEvent = {
  t: number;
  type: 'startup' | 'hit' | 'blocked' | 'whiff' | 'counter' | 'ko' | 'timeout';
  attacker: PlayerId;
  move: string;
  damage?: number;
  hitstopFrames?: number;
};

// ---------------------------------------------------------------------------
// Forge -> Game
// ---------------------------------------------------------------------------

export type ForgedFighter = {
  id: string;
  name: string; // typed in by the player before the scan
  status: 'scanning' | 'forging' | 'ready' | 'failed';
  step?: 'brief' | 'sheet' | 'model' | 'cleanup' | 'rig';
  glbUrl?: string; // 1 m tall; forged models use Mixamo bones, static test models may be unrigged
  cardUrl?: string; // VS card art
  sheetUrl?: string; // A-pose model sheet (input to the 3D step)
  brief?: Record<string, unknown>; // see SPEC.md "Prompts" for the shape
  error?: string; // why the forge failed
  // The forging screen's live preview (forge/pipeline.js), each as soon as it exists:
  sheetPartialUrl?: string; // the sheet while OpenAI is still drawing it (WebP)
  previewVoxelsUrl?: string; // TRELLIS stage 1's sparse voxels: uint16 resolution, then x, y, z bytes (z up)
  previewMeshUrl?: string; // the untextured shape (small GLB, y up)
};

/** What a forging fighter's live preview shows, stage by stage (see ForgePreview.tsx). */
export type ForgePreview = {
  name?: string; // the brief's fighter name and archetype, typed out
  archetype?: string;
  dossier?: string[]; // more of the brief (build, signature details, scout report), typed out while the sheet draws
  palette?: string[]; // the brief's colors (hex)
  sheetUrl?: string; // the sheet developing: the partial, then the final one
  sheetFinal?: boolean;
  voxelsUrl?: string; // a voxel hologram
  meshUrl?: string; // gray clay
  glbUrl?: string; // textured, then the rig flashes: the finished fighter
  step?: ForgedFighter['step']; // the forge's own step (the rig step has nothing new to show but its name)
};
