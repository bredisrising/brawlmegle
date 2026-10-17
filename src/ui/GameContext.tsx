import { createContext, useContext } from 'react';
import type { Game } from '../game/Game';

export const GameContext = createContext<Game | null>(null);

export function useGame() {
  const game = useContext(GameContext);
  if (!game) throw new Error('useGame must be used inside <GameContext.Provider>');
  return game;
}
