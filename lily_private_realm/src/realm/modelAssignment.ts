import { browserModelUrl } from './browserSession'

export type PrivateModelAssignment = {
  model_id: string
  model_url: string
  expression_options: string[]
  expression_map: Record<string, string>
}

const MODEL_VESSEL_URL = import.meta.env.VITE_MODEL_VESSEL_URL ?? 'http://127.0.0.1:10898'
const CACHE_KEY = 'lily_live2d_context_private_realm'

export async function loadPrivateModelAssignment(): Promise<PrivateModelAssignment | null> {
  try {
    const response = await fetch(browserModelUrl(`${MODEL_VESSEL_URL}/api/assignments/private_realm`), {
      credentials: 'include',
    })
    if (!response.ok) return null
    const model = (await response.json()) as PrivateModelAssignment
    window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(model))
    return model
  } catch {
    return null
  }
}

export function readPrivateModelContext() {
  try {
    const raw = window.sessionStorage.getItem(CACHE_KEY)
    const model = raw ? (JSON.parse(raw) as PrivateModelAssignment) : null
    return {
      live2d_model_id: model?.model_id,
      live2d_expression_options: model?.expression_options ?? [],
    }
  } catch {
    return { live2d_model_id: undefined, live2d_expression_options: [] as string[] }
  }
}

