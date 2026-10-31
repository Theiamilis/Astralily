import { useEffect, useRef, useState } from 'react';

export function useDashboardAudio(url: string | null, stopSignal: number) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const levelRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setError('');
    setPlaying(false);
    if (!url) return;
    const audio = new Audio(url);
    audio.crossOrigin = 'anonymous';
    audioRef.current = audio;
    let context: AudioContext | null = null;
    let source: MediaElementAudioSourceNode | null = null;
    let frame = 0;
    let disposed = false;

    const stopMeter = () => {
      cancelAnimationFrame(frame);
      levelRef.current = 0;
      if (!disposed) setPlaying(false);
    };
    const startMeter = () => {
      if (disposed) return;
      setPlaying(true);
      setError('');
      cancelAnimationFrame(frame);
      try {
        if (!context && window.AudioContext) {
          context = new AudioContext();
          source = context.createMediaElementSource(audio);
          const analyser = context.createAnalyser();
          analyser.fftSize = 256;
          source.connect(analyser);
          analyser.connect(context.destination);
          analyserRef.current = analyser;
        }
        void context?.resume().catch(() => undefined);
      } catch {
        // A connected media source must still reach the speakers if analysis setup fails.
        if (context && source && !analyserRef.current) {
          try { source.connect(context.destination); } catch { /* Native playback may still be available. */ }
        }
      }
      const samples = new Uint8Array(256);
      const tick = () => {
        if (disposed || audio.paused || audio.ended) return;
        const analyser = analyserRef.current;
        if (analyser) {
          analyser.getByteTimeDomainData(samples);
          const energy = samples.reduce((sum, sample) => sum + ((sample - 128) / 128) ** 2, 0);
          levelRef.current = Math.min(1, Math.sqrt(energy / samples.length) * 3.8);
        }
        frame = requestAnimationFrame(tick);
      };
      tick();
    };
    const failed = () => {
      stopMeter();
      if (!disposed) setError('Voice playback is unavailable.');
    };
    audio.addEventListener('playing', startMeter);
    audio.addEventListener('pause', stopMeter);
    audio.addEventListener('ended', stopMeter);
    audio.addEventListener('error', failed);
    void audio.play().catch(() => {
      if (!disposed) setError('Press Play voice to allow audio.');
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      audio.removeEventListener('playing', startMeter);
      audio.removeEventListener('pause', stopMeter);
      audio.removeEventListener('ended', stopMeter);
      audio.removeEventListener('error', failed);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      source?.disconnect();
      analyserRef.current?.disconnect();
      analyserRef.current = null;
      audioRef.current = null;
      levelRef.current = 0;
      void context?.close().catch(() => undefined);
    };
  }, [url, stopSignal]);

  const resume = () => {
    void audioRef.current?.play().catch(() => setError('Voice playback is unavailable.'));
  };
  return { playing, error, resume, analyserRef, levelRef };
}

export type DashboardAudio = ReturnType<typeof useDashboardAudio>;
