import { launcherFetch } from './browserSession';

export const CORE_URL_STORAGE_KEY = 'lily_control_center_core_url';

export function readCoreApiUrl(fallback: string) {
  if (typeof window === 'undefined') return fallback;
  return window.localStorage.getItem(CORE_URL_STORAGE_KEY)?.trim() || fallback;
}

export function coreFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  return launcherFetch('core', String(input), init);
}

export type CoreEvent = { id: number; type: string; data: string };

type EventChannel = { listeners: Set<(event: CoreEvent) => void>; controller: AbortController };
const channels = new Map<string, EventChannel>();

export function subscribeCoreEvents(baseUrl: string, listener: (event: CoreEvent) => void) {
  const base = baseUrl.replace(/\/+$/, '');
  let channel = channels.get(base);
  if (!channel) {
    channel = { listeners: new Set(), controller: new AbortController() };
    channels.set(base, channel);
    channel.listeners.add(listener);
    void runChannel(base, channel);
  } else channel.listeners.add(listener);
  const subscribedChannel = channel;
  return () => {
    subscribedChannel.listeners.delete(listener);
    if (!subscribedChannel.listeners.size) {
      subscribedChannel.controller.abort();
      if (channels.get(base) === subscribedChannel) channels.delete(base);
    }
  };
}

async function runChannel(base: string, channel: EventChannel) {
  const { signal } = channel.controller;
  const cursorKey = `lily_core_event_id:${base}`;
  let cursor = Number(window.sessionStorage.getItem(cursorKey) || 0);
  while (!signal.aborted) {
    try {
      const headers = new Headers({ Accept: 'text/event-stream' });
      if (cursor > 0) headers.set('Last-Event-ID', String(cursor));
      const response = await launcherFetch('core', `${base}/api/events/stream`, { headers, signal });
      if (!response.ok || !response.body) throw new Error(`event stream failed: ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          buffer = buffer.replace(/\r\n/g, '\n');
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            let id = 0;
            let type = 'message';
            const data: string[] = [];
            for (const line of block.split('\n')) {
              if (line.startsWith('id:')) id = Number(line.slice(3).trim()) || id;
              else if (line.startsWith('event:')) type = line.slice(6).trim();
              else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
            }
            const duplicate = id > 0 && id <= cursor;
            if (id > cursor) {
              cursor = id;
              window.sessionStorage.setItem(cursorKey, String(cursor));
            }
            if (data.length && !duplicate) {
              for (const callback of channel.listeners) {
                try { callback({ id, type, data: data.join('\n') }); }
                catch { console.warn('A Core event subscriber could not update.'); }
              }
            }
            boundary = buffer.indexOf('\n\n');
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    } catch {
      // Reconnect below; each Core URL has one shared replay cursor and connection.
    }
    if (!signal.aborted) await new Promise<void>((resolve) => {
      const finish = () => { window.clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
      const timer = window.setTimeout(finish, 2000);
      signal.addEventListener('abort', finish, { once: true });
    });
  }
}
