const LAUNCHER_ORIGIN = 'http://127.0.0.1:5240'
if (window.location.hostname === 'localhost' && window.location.port === '5230') {
  window.location.replace(`http://127.0.0.1:5230${window.location.pathname}${window.location.search}${window.location.hash}`)
}
let csrfPromise: Promise<string> | null = null

async function csrfToken(): Promise<string> {
  if (!csrfPromise) {
    csrfPromise = fetch(`${LAUNCHER_ORIGIN}/api/browser-session`, { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Open IRIS Launcher to authorize Private Realm.')
        const payload = await response.json() as { csrf?: string }
        if (!payload.csrf) throw new Error('IRIS Launcher session is unavailable.')
        return payload.csrf
      })
      .catch((error) => { csrfPromise = null; throw error })
  }
  return csrfPromise
}

export function browserCoreUrl(path: string): string {
  const parsed = new URL(path, window.location.origin)
  return `${LAUNCHER_ORIGIN}/browser/core${parsed.pathname}${parsed.search}`
}

export function browserModelUrl(path: string): string {
  const parsed = new URL(path, window.location.origin)
  return `${LAUNCHER_ORIGIN}/browser/model${parsed.pathname}${parsed.search}`
}

export async function browserCoreCsrf(): Promise<string> {
  return csrfToken()
}
