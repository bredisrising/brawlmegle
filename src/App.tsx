import { useEffect, useRef, useState } from 'react';
import { Game } from './game/Game';
import { GameContext } from './ui/GameContext';
import { HUD } from './ui/HUD';
import { PlayerSlot } from './ui/PlayerSlot';
import { Countdown } from './ui/Countdown';
import { HitPopups } from './ui/HitPopups';
import { ScreenFlash } from './ui/ScreenFlash';
import { KOOverlay } from './ui/KOOverlay';
import { DebugHint } from './ui/DebugHint';

export default function App() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [game, setGame] = useState<Game | null>(null);

  useEffect(() => {
    const g = new Game(canvasRef.current!);
    setGame(g);
    return () => {
      g.dispose();
      setGame(null);
    };
  }, []);

  return (
    <div className="relative h-full w-full select-none overflow-hidden">
      {/* 3D scene fills the screen; everything else is an overlay. */}
      <div ref={canvasRef} className="absolute inset-0" />

      {game && (
        <GameContext.Provider value={game}>
          <div className="pointer-events-none absolute inset-0">
            <PlayerSlot id="p1" />
            <PlayerSlot id="p2" />
            <HitPopups />
            <ScreenFlash />
            <Countdown />
            <KOOverlay />
            <HUD />
            <DebugHint />
          </div>
        </GameContext.Provider>
      )}
    </div>
  );
}
