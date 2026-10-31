import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CircleAlert,
  Library,
  LoaderCircle,
  Monitor,
  Pencil,
  Play,
  Radio,
  RefreshCcw,
  Save,
  Trash2,
  Upload,
  UserRound,
  X
} from 'lucide-react';
import { Live2DDock } from './Live2DDock';
import {
  assignLive2DModel,
  deleteLive2DModel,
  fetchModelLibrary,
  renameLive2DModel,
  saveExpressionMappings,
  uploadLive2DModel,
  type Live2DModel,
  type ModelExpression
} from '../modelLibraryApi';
import './ModelLibrary.css';

type ModelLibraryProps = {
  onClose: () => void;
};

const TARGETS = [
  { id: 'global', label: 'Global', icon: Library },
  { id: 'control_center', label: 'Control', icon: Monitor },
  { id: 'stream_stage', label: 'Stream', icon: Radio },
  { id: 'private_realm', label: 'Private', icon: UserRound }
] as const;

export function ModelLibrary({ onClose }: ModelLibraryProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [models, setModels] = useState<Live2DModel[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [semanticOptions, setSemanticOptions] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftExpressions, setDraftExpressions] = useState<ModelExpression[]>([]);
  const [previewExpression, setPreviewExpression] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState(0);
  const [status, setStatus] = useState('Loading model library...');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = useMemo(
    () => models.find((model) => model.model_id === selectedId) ?? null,
    [models, selectedId]
  );

  const loadLibrary = async (preferredId?: string) => {
    setError(null);
    try {
      const data = await fetchModelLibrary();
      setModels(data.models);
      setAssignments(data.assignments);
      setSemanticOptions(data.semantic_options);
      setSelectedId((current) => {
        const next = preferredId || current || data.assignments.control_center || data.assignments.global;
        return data.models.some((model) => model.model_id === next)
          ? next
          : data.models[0]?.model_id || null;
      });
      setStatus(`${data.models.length} models ready`);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Model Vessel is unavailable.');
      setStatus('Model Vessel offline');
    }
  };

  useEffect(() => {
    void loadLibrary();
  }, []);

  useEffect(() => {
    setDraftName(selected?.display_name || '');
    setDraftExpressions(selected?.expressions.map((item) => ({ ...item })) || []);
    setPreviewExpression(null);
  }, [selected]);

  const runMutation = async (label: string, action: () => Promise<unknown>, preferredId?: string) => {
    setBusy(true);
    setError(null);
    setStatus(label);
    try {
      await action();
      await loadLibrary(preferredId);
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : 'Model operation failed.');
      setStatus('Action failed');
    } finally {
      setBusy(false);
    }
  };

  const handleUpload = (file: File | undefined) => {
    if (!file) return;
    void runMutation('Validating and installing model...', async () => {
      const installed = await uploadLive2DModel(file);
      setSelectedId(installed.model_id);
    });
  };

  const updateExpression = (rawName: string, patch: Partial<ModelExpression>) => {
    setDraftExpressions((current) => current.map((item) => {
      if (patch.semantic_key && item.raw_name !== rawName && item.semantic_key === patch.semantic_key) {
        return { ...item, semantic_key: null };
      }
      return item.raw_name === rawName ? { ...item, ...patch } : item;
    }));
  };

  return (
    <div className="model-library-backdrop" role="dialog" aria-modal="true" aria-label="Live2D Model Library">
      <section className="model-library-shell">
        <header className="model-library-header">
          <div className="model-library-title">
            <span className="model-library-title-icon"><Library /></span>
            <div>
              <p>Wardrobe</p>
              <h2>Live2D Model Library</h2>
            </div>
          </div>
          <div className="model-library-header-actions">
            <span className={error ? 'model-library-status is-error' : 'model-library-status'}>
              {busy ? <LoaderCircle className="is-spinning" /> : error ? <CircleAlert /> : <Check />}
              {error || status}
            </span>
            <button type="button" className="model-icon-button" onClick={() => void loadLibrary()} title="Refresh model library">
              <RefreshCcw />
            </button>
            <button type="button" className="model-icon-button" onClick={onClose} title="Close model library">
              <X />
            </button>
          </div>
        </header>

        <div className="model-library-workspace">
          <aside className="model-library-list" aria-label="Installed Live2D models">
            <input
              ref={fileInputRef}
              hidden
              type="file"
              accept=".zip,application/zip"
              onChange={(event) => {
                handleUpload(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            <button type="button" className="model-upload-button" onClick={() => fileInputRef.current?.click()} disabled={busy}>
              <Upload />
              <span>Install model ZIP</span>
            </button>
            <div className="model-list-scroll">
              {models.map((model) => (
                <button
                  type="button"
                  key={model.model_id}
                  className={model.model_id === selectedId ? 'model-list-row is-active' : 'model-list-row'}
                  onClick={() => setSelectedId(model.model_id)}
                >
                  <span className="model-list-avatar">{model.display_name.slice(0, 2).toUpperCase()}</span>
                  <span className="model-list-copy">
                    <strong>{model.display_name}</strong>
                    <small>{model.expressions.length} expressions</small>
                  </span>
                  {Object.values(assignments).includes(model.model_id) ? <Check className="model-list-check" /> : null}
                </button>
              ))}
              {models.length === 0 && !error ? <p className="model-empty-state">No models installed.</p> : null}
            </div>
          </aside>

          <main className="model-preview-column">
            {selected ? (
              <>
                <div className="model-preview-toolbar">
                  <div>
                    <p>Preview</p>
                    <strong>{selected.display_name}</strong>
                  </div>
                  <span>{previewExpression || 'Idle motion'}</span>
                </div>
                <div className="model-preview-stage">
                  <Live2DDock
                    modelUrl={selected.model_url}
                    expressionPresets={selected.expressions}
                    expression={previewExpression}
                    expressionKey={previewKey}
                    expressionPanelOpen={false}
                  />
                </div>
                <div className="model-assignment-band">
                  <div>
                    <p>Use this model</p>
                    <span>Target-specific choices override Global.</span>
                  </div>
                  <div className="model-assignment-actions">
                    {TARGETS.map(({ id, label, icon: Icon }) => (
                      <button
                        type="button"
                        key={id}
                        className={assignments[id] === selected.model_id ? 'is-selected' : ''}
                        onClick={() => void runMutation(`Assigning ${label}...`, async () => {
                          await assignLive2DModel(selected.model_id, id);
                          const detail = { target: id, changed_at: Date.now() };
                          window.localStorage.setItem('lily_model_assignment_changed', JSON.stringify(detail));
                          window.dispatchEvent(new CustomEvent('lily-model-assignment-changed', { detail }));
                        }, selected.model_id)}
                        disabled={busy}
                      >
                        <Icon />
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <div className="model-preview-empty"><Library /><p>Install or select a Live2D model.</p></div>
            )}
          </main>

          <aside className="model-expression-editor" aria-label="Model expression mapping">
            {selected ? (
              <>
                <div className="model-name-editor">
                  <label htmlFor="model-display-name">Display name</label>
                  <div>
                    <Pencil />
                    <input id="model-display-name" value={draftName} maxLength={80} onChange={(event) => setDraftName(event.target.value)} />
                    <button
                      type="button"
                      onClick={() => void runMutation('Renaming model...', () => renameLive2DModel(selected.model_id, draftName), selected.model_id)}
                      disabled={busy || !draftName.trim() || draftName.trim() === selected.display_name}
                      title="Save model name"
                    ><Save /></button>
                  </div>
                </div>

                <div className="expression-editor-heading">
                  <div><p>Expression map</p><span>Give raw presets a meaning Lily understands.</span></div>
                  <button
                    type="button"
                    onClick={() => void runMutation('Saving expression map...', () => saveExpressionMappings(selected.model_id, draftExpressions), selected.model_id)}
                    disabled={busy}
                  ><Save /> Save</button>
                </div>

                <div className="expression-table">
                  <div className="expression-table-head"><span>Preset</span><span>Lily meaning</span><span>Test</span></div>
                  {draftExpressions.map((item) => (
                    <div className="expression-table-row" key={item.raw_name}>
                      <div className="expression-preset-fields">
                        <input
                          aria-label={`Display name for ${item.raw_name}`}
                          value={item.display_name}
                          maxLength={80}
                          onChange={(event) => updateExpression(item.raw_name, { display_name: event.target.value })}
                        />
                        <div className="expression-preset-meta">
                          <small>{item.raw_name}</small>
                          <label>
                            <input
                              type="checkbox"
                              checked={Boolean(item.default_active)}
                              onChange={(event) => updateExpression(item.raw_name, { default_active: event.target.checked })}
                            />
                            <span>Default on</span>
                          </label>
                        </div>
                      </div>
                      <select
                        aria-label={`Meaning for ${item.raw_name}`}
                        value={item.semantic_key || ''}
                        onChange={(event) => updateExpression(item.raw_name, { semantic_key: event.target.value || null })}
                      >
                        <option value="">Unmapped</option>
                        {semanticOptions.map((option) => <option value={option} key={option}>{option}</option>)}
                      </select>
                      <button
                        type="button"
                        className="expression-test-button"
                        onClick={() => {
                          setPreviewExpression(item.raw_name);
                          setPreviewKey((current) => current + 1);
                        }}
                        title={`Test ${item.display_name}`}
                      ><Play /></button>
                    </div>
                  ))}
                  {draftExpressions.length === 0 ? <p className="model-empty-state">This model has no expression presets.</p> : null}
                </div>

                <button
                  type="button"
                  className="model-delete-button"
                  disabled={busy || selected.assigned_targets.length > 0}
                  title={selected.assigned_targets.length ? 'Assign another model to every active target before deleting.' : 'Delete model'}
                  onClick={() => void runMutation('Deleting model...', () => deleteLive2DModel(selected.model_id))}
                ><Trash2 /> Delete model</button>
              </>
            ) : null}
          </aside>
        </div>
      </section>
    </div>
  );
}
