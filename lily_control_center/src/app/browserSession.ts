const LAUNCHER_ORIGIN = (import.meta.env.VITE_IRIS_LAUNCHER_ORIGIN || 'http://127.0.0.1:5240').replace(/\/+$/, '');

if (window.location.hostname === 'localhost' && window.location.port === '5231') {
  window.location.replace(`http://127.0.0.1:5231${window.location.pathname}${window.location.search}${window.location.hash}`);
}

let csrfPromise: Promise<string> | null = null;

export function launcherProxyUrl(service: 'core' | 'wa' | 'model', url: string): string {
  const parsed = new URL(url, window.location.origin);
  return `${LAUNCHER_ORIGIN}/browser/${service}${parsed.pathname}${parsed.search}`;
}

async function csrfToken(): Promise<string> {
  if (!csrfPromise) {
    csrfPromise = fetch(`${LAUNCHER_ORIGIN}/api/browser-session`, { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Open IRIS Launcher to authorize browser controls.');
        const payload = await response.json() as { csrf?: string };
        if (!payload.csrf) throw new Error('IRIS Launcher session is unavailable.');
        return payload.csrf;
      })
      .catch((error) => { csrfPromise = null; throw error; });
  }
  return csrfPromise;
}

export async function launcherFetch(
  service: 'core' | 'wa' | 'model',
  input: string | URL,
  init: RequestInit = {}
): Promise<Response> {
  const method = (init.method || 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  if (method !== 'GET' && method !== 'HEAD') {
    headers.set('X-IRIS-CSRF', await csrfToken());
  }
  return fetch(launcherProxyUrl(service, String(input)), {
    ...init,
    headers,
    credentials: 'include',
  });
}
