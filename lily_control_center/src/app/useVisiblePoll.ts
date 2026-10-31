import { useEffect, useRef } from 'react';

export function useVisiblePoll(run: (signal: AbortSignal) => Promise<void>, interval = 15000) {
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    let busy = false;
    const poll = async () => {
      if (controller.signal.aborted || document.hidden || busy) return;
      window.clearTimeout(timer);
      busy = true;
      try { await runRef.current(controller.signal); }
      finally {
        busy = false;
        if (!controller.signal.aborted && !document.hidden) timer = window.setTimeout(poll, interval);
      }
    };
    const visibility = () => {
      window.clearTimeout(timer);
      if (!document.hidden) void poll();
    };
    void poll();
    document.addEventListener('visibilitychange', visibility);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [interval]);
}
