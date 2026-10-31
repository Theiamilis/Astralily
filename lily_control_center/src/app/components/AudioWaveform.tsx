import { useEffect, useRef } from 'react';
import type { DashboardAudio } from '../useDashboardAudio';
import type { OverviewTheme } from '../overviewTheme';

export function AudioWaveform({ audio, thinking, theme }: { audio: DashboardAudio; thinking: boolean; theme: OverviewTheme }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    let frame = 0;
    let lastDraw = 0;
    const samples = new Uint8Array(128);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const draw = (time = 0) => {
      const { width, height } = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const analyser = audio.analyserRef.current;
      if (analyser && audio.playing) analyser.getByteFrequencyData(samples);
      else samples.fill(0);
      const count = 44;
      const gap = Math.min(4, width / (count * 2));
      const barWidth = Math.max(1, (width - gap * (count - 1)) / count);
      context.fillStyle = getComputedStyle(canvas).getPropertyValue(audio.playing ? '--overview-wave-active' : '--overview-wave-idle').trim();
      for (let i = 0; i < count; i++) {
        const mirror = Math.abs(i - (count - 1) / 2) / (count / 2);
        const energy = audio.playing ? samples[Math.floor(mirror * 100)] / 255 : 0;
        const barHeight = Math.max(3, energy * height * 0.85);
        context.fillRect(i * (barWidth + gap), (height - barHeight) / 2, barWidth, barHeight);
      }
      lastDraw = time;
    };
    const tick = (time: number) => {
      if (time - lastDraw >= 32) draw(time);
      frame = requestAnimationFrame(tick);
    };
    const restart = () => {
      cancelAnimationFrame(frame);
      draw();
      if (audio.playing && !document.hidden && !reducedMotion.matches) frame = requestAnimationFrame(tick);
    };
    const observer = new ResizeObserver(restart);
    observer.observe(canvas);
    document.addEventListener('visibilitychange', restart);
    reducedMotion.addEventListener('change', restart);
    restart();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('visibilitychange', restart);
      reducedMotion.removeEventListener('change', restart);
    };
  }, [audio.playing, audio.analyserRef, theme]);
  const status = audio.error ? 'Voice paused' : audio.playing ? 'Lily is speaking' : thinking ? 'Lily is thinking' : 'Lily is ready';
  return <div className="overview-waveform">
    <canvas ref={canvasRef} aria-hidden="true" />
    <div className="overview-waveform-caption"><p role="status">{status}</p>{audio.error ? <button type="button" onClick={audio.resume}>Play voice</button> : null}</div>
    {audio.error ? <p className="overview-waveform-error">{audio.error}</p> : null}
  </div>;
}
