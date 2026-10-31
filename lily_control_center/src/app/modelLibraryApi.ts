import { launcherFetch } from './browserSession';

export const MODEL_VESSEL_URL =
  import.meta.env.VITE_MODEL_VESSEL_URL ?? 'http://127.0.0.1:10898';

export type ModelExpression = {
  raw_name: string;
  file_name: string;
  display_name: string;
  semantic_key: string | null;
  default_active: boolean;
  sort_order: number;
};

export type Live2DModel = {
  model_id: string;
  display_name: string;
  model_json_path: string;
  model_url: string;
  asset_url: string;
  content_hash: string;
  expressions: ModelExpression[];
  assigned_targets: string[];
  expression_options?: string[];
  expression_map?: Record<string, string>;
  requested_target?: string;
  resolved_from?: string;
};

export type ModelLibraryResponse = {
  models: Live2DModel[];
  assignments: Record<string, string>;
  semantic_options: string[];
  assignment_targets: string[];
};

function headers(includeJson = false): HeadersInit {
  return {
    ...(includeJson ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.detail || `Model Vessel request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

export async function fetchModelLibrary(): Promise<ModelLibraryResponse> {
  return readResponse(await launcherFetch('model', `${MODEL_VESSEL_URL}/api/models`));
}

export async function fetchModelAssignment(target: string): Promise<Live2DModel> {
  return readResponse(await launcherFetch('model', `${MODEL_VESSEL_URL}/api/assignments/${target}`));
}

export async function uploadLive2DModel(file: File, displayName?: string): Promise<Live2DModel> {
  const body = new FormData();
  body.append('archive', file);
  if (displayName?.trim()) body.append('display_name', displayName.trim());
  return readResponse(
    await launcherFetch('model', `${MODEL_VESSEL_URL}/api/models/upload`, {
      method: 'POST',
      headers: headers(),
      body
    })
  );
}

export async function renameLive2DModel(modelId: string, displayName: string): Promise<Live2DModel> {
  return readResponse(
    await launcherFetch('model', `${MODEL_VESSEL_URL}/api/models/${modelId}`, {
      method: 'PATCH',
      headers: headers(true),
      body: JSON.stringify({ display_name: displayName })
    })
  );
}

export async function saveExpressionMappings(
  modelId: string,
  expressions: ModelExpression[]
): Promise<Live2DModel> {
  return readResponse(
    await launcherFetch('model', `${MODEL_VESSEL_URL}/api/models/${modelId}/expressions`, {
      method: 'PUT',
      headers: headers(true),
      body: JSON.stringify({
        expressions: expressions.map(({ raw_name, display_name, semantic_key, default_active }) => ({
          raw_name,
          display_name,
          semantic_key: semantic_key || null,
          default_active
        }))
      })
    })
  );
}

export async function assignLive2DModel(modelId: string, target: string): Promise<Live2DModel> {
  return readResponse(
    await launcherFetch('model', `${MODEL_VESSEL_URL}/api/models/${modelId}/select`, {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify({ target })
    })
  );
}

export async function deleteLive2DModel(modelId: string): Promise<void> {
  await readResponse(
    await launcherFetch('model', `${MODEL_VESSEL_URL}/api/models/${modelId}`, {
      method: 'DELETE',
      headers: headers()
    })
  );
}
