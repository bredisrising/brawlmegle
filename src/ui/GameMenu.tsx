import { useEffect, useState } from 'react';
import { setCamHidden, useGameStore } from '../game/store';
import { TextButton } from './ArcadeButton';
import { useGame } from './GameContext';
import { recordingEnabled, setRecordingEnabled, setVideoEnabled, videoEnabled } from '../game/MatchRecorder';

/**
 * Bottom-right during a match (above the move guide chip): the link to the other laptop (ping, direct or relayed) and a small menu
 * (Esc) to change fighter or go back to the title.
 */
const PATH_LABEL = { cable: 'Cable', lan: 'LAN', internet: 'P2P', relay: 'Relay' } as const;

export function GameMenu() {
  const game = useGame();
  const role = useGameStore((s) => s.role);
  const link = useGameStore((s) => s.link);
  const connection = useGameStore((s) => s.connection);
  const watchers = useGameStore((s) => s.watchers);
  const roomCode = useGameStore((s) => s.roomCode);
  const replay = useGameStore((s) => s.replay);
  const walkout = useGameStore((s) => s.walkout);
  const [open, setOpen] = useState(false);
  const [recording, setRecording] = useState(recordingEnabled);
  const [video, setVideo] = useState(videoEnabled);
  const rec = useGameStore((s) => s.recordingVideo);
  const quick = useGameStore((s) => s.quick);
  const camHidden = useGameStore((s) => s.camHidden);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen((o) => !o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (replay || walkout) return null; // cutscenes: nothing over them

  const rtt = link?.rttMs;
  const tone = rtt === null || rtt === undefined ? 'text-paper/60' : rtt < 60 ? 'text-hp' : rtt < 120 ? 'text-paper' : 'text-dmg';
  return (
    <div className="pointer-events-auto absolute bottom-14 right-4 flex flex-col items-end gap-2">
      {open && (
        <div className="animate-rise flex flex-col items-end gap-3 bg-ink/90 px-4 py-3">
          {quick && role !== 'spectator' && <TextButton onClick={() => (setOpen(false), game.nextOpponent())}>Next opponent</TextButton>}
          {role === 'host' && !quick && <TextButton onClick={() => (setOpen(false), game.changeFighter())}>Change fighter</TextButton>}
          {role !== 'spectator' && (
            <TextButton
              title="Hidden: your opponent doesn't see your camera, and you don't see theirs"
              onClick={() => setCamHidden(!camHidden)}
            >
              Hide my camera: {camHidden ? 'on' : 'off'}
            </TextButton>
          )}
          {role === 'host' && (
            <TextButton
              title="Saves both players' movement points (no video) after each round, to improve move detection"
              onClick={() => {
                setRecordingEnabled(!recording);
                setRecording(!recording);
              }}
            >
              Record for training: {recording ? 'on' : 'off'}
            </TextButton>
          )}
          {role !== 'spectator' && (
            <TextButton
              title="Also saves this laptop's camera video each round (for checking moves); next round on"
              onClick={() => {
                setVideoEnabled(!video);
                setVideo(!video);
              }}
            >
              Camera video: {video ? 'on' : 'off'}
            </TextButton>
          )}
          <TextButton onClick={() => game.toTitle()}>Back to title</TextButton>
        </div>
      )}
      <div className="flex items-stretch gap-1">
        {rec && (
          <span className="flex items-center gap-1.5 bg-ink/80 px-2.5 py-1.5 font-cond text-xs font-bold uppercase tracking-[0.2em] text-dmg" title="This camera is being recorded for training">
            <span className="animate-blink size-2 rounded-full bg-dmg" />
            Rec
          </span>
        )}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="bg-ink/80 px-3 py-1.5 font-cond text-xs font-bold uppercase tracking-[0.2em] text-paper/70 hover:text-paper"
        >
          Menu [Esc]
        </button>
        {role === 'host' && watchers > 0 && (
          <span className="bg-ink/80 px-3 py-1.5 font-cond text-xs font-bold uppercase tracking-[0.2em] text-paper/70" title="Screens showing this fight (Watch on the title screen)">
            {watchers} watching
          </span>
        )}
        {role === 'spectator' ? (
          <span className={`bg-ink/80 px-3 py-1.5 font-cond text-xs font-bold uppercase tracking-[0.2em] ${connection === 'reconnecting' ? 'text-dmg' : 'text-paper/70'}`}>
            {connection === 'reconnecting' ? 'Reconnecting…' : `Watching ${roomCode ?? ''}`}
          </span>
        ) : connection && (
          <span className={`bg-ink/80 px-3 py-1.5 font-cond text-xs font-bold uppercase tracking-[0.2em] ${tone}`} title={`Round trip to the other laptop${link?.address ? ` (from ${link.address})` : ''}`}>
            {connection === 'reconnecting' ? 'Reconnecting…' : `${PATH_LABEL[link?.path ?? 'internet']} ${rtt ?? '–'} ms`}
          </span>
        )}
      </div>
    </div>
  );
}
