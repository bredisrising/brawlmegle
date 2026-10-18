import { useEffect, useRef, useState } from 'react';
import { config } from '../config';
import { useGameStore } from '../game/store';
import { CamToggle } from './CamToggle';

/**
 * The title screen's corner mirror: this laptop's camera, small, top right, from the moment the site opens (so the
 * camera is sorted before the first fight), with the "My camera" switch under it. Only the camera's picture: the pose
 * model starts with a fight. The stream stops when the title closes; the fight opens its own.
 */
export function TitleCam() {
  const ref = useRef<HTMLVideoElement>(null);
  const [live, setLive] = useState(false);
  const hidden = useGameStore((s) => s.camHidden);

  useEffect(() => {
    if (config.input !== 'camera' || !navigator.mediaDevices?.getUserMedia) return;
    let stream: MediaStream | null = null;
    let gone = false;
    navigator.mediaDevices
      // Same settings the fight asks for, so the camera doesn't have to switch modes when it starts.
      .getUserMedia({ audio: false, video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 }, facingMode: 'user' } })
      .then((s) => {
        if (gone) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        if (ref.current) ref.current.srcObject = s;
        setLive(true);
      })
      .catch(() => {}); // no camera or no permission yet: the fight asks again, and says why
    return () => {
      gone = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  if (config.input !== 'camera') return null;
  return (
    <div className={`animate-rise absolute right-4 top-4 z-10 hidden flex-col items-end gap-1.5 md:flex sm:right-6 sm:top-6 ${live ? '' : 'invisible'}`}>
      <div className="relative aspect-[4/3] w-[clamp(7.5rem,11vw,10.5rem)] overflow-hidden border-2 border-paper/25 bg-black shadow-2xl">
        <video ref={ref} autoPlay muted playsInline className="size-full -scale-x-100 object-cover" />
        <span className="absolute left-1 top-1 bg-black/70 px-1.5 py-0.5 font-cond text-[9px] font-bold uppercase tracking-[0.15em] text-paper/75">
          {hidden ? 'Hidden from opponents' : 'Shown to opponents'}
        </span>
      </div>
      <CamToggle />
    </div>
  );
}
