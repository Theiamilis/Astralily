import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LoaderCircle, Sparkles, Wand2 } from 'lucide-react';
import { fetchModelAssignment, type Live2DModel, type ModelExpression } from '../modelLibraryApi';
import './ExpressionControls.css';

type Live2DDockProps = {
  externalPlayback?: boolean;
  audioLevelRef?: { current: number };
  audioUrl?: string | null;
  expression?: string | null;
  expressionKey?: string | number | null;
  idleExpression?: string | null;
  stopSignal?: number;
  viewportScale?: number;
  viewportX?: number;
  viewportY?: number;
  viewportResetKey?: string | number | null;
  expressionPanelOpen?: boolean;
  expressionPanelTarget?: HTMLElement | null;
  expressionPanelPlacement?: 'top' | 'bottom';
  onSpeakingChange?: (isSpeaking: boolean) => void;
  onExpressionResolved?: (resolution: DockExpressionResolution) => void;
  modelUrl?: string | null;
  expressionMap?: Record<string, string>;
  expressionPresets?: ModelExpression[];
  assignmentTarget?: 'control_center' | 'stream_stage' | 'private_realm';
  onModelContextChange?: (model: Live2DModel | null) => void;
};

type ExpressionOption = {
  name: string;
  file: string;
  displayName: string;
  semanticKey: string | null;
};

export type DockExpressionResolution = {
  requested: string;
  resolved: string;
  source: 'direct' | 'alias' | 'idle_fallback' | 'first_fallback';
};

const LIVE2D_MODEL_URL = import.meta.env.VITE_LIVE2D_MODEL_URL ?? '/live2d/haru/Haru.model3.json';
const EXPRESSION_DECAY_MS = 9000;
const IDLE_EXPRESSION = 'Blush';

const EXPRESSION_ALIASES: Record<string, string[]> = {
  happy: ['Love', 'Soft Love', 'Sparkle Mood', 'F01', 'F02'],
  joy: ['Love', 'Soft Love', 'Sparkle Mood', 'F01', 'F02'],
  cheerful: ['Love', 'Soft Love', 'Sparkle Mood', 'F01', 'F02'],
  excited: ['Sparkle Mood', 'Love', 'F07', 'F02'],
  sparkle: ['Sparkle Mood', 'Sparkle A', 'Sparkle B', 'F07'],
  love: ['Love', 'Soft Love', 'F01'],
  cute: ['Soft Love', 'Love', 'Blush', 'F02'],
  sweet: ['Soft Love', 'Love', 'Blush', 'F02'],
  blush: ['Blush', 'Shy', 'F03'],
  shy: ['Shy', 'Blush', 'F03'],
  embarrassed: ['Shy', 'Blush', 'Sweat', 'F03'],
  neutral: ['Blush', 'F01'],
  calm: ['Blush', 'F01'],
  sad: ['Gloomy', 'Crying', 'F04'],
  gloomy: ['Gloomy', 'Crying', 'F04'],
  worried: ['Gloomy', 'Sweat', 'F06'],
  cry: ['Crying', 'Gloomy', 'F04'],
  crying: ['Crying', 'Gloomy', 'F04'],
  nervous: ['Sweat', 'Shy', 'F06'],
  sweat: ['Sweat', 'F06'],
  awkward: ['Sweat', 'Shy', 'F06'],
  angry: ['Angry', 'Gloomy', 'F05'],
  warning: ['Angry', 'Sweat', 'F05'],
  serious: ['Angry', 'F05']
};

function normalizeExpressionName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function resolveExpression(
  target: string | null | undefined,
  expressions: ExpressionOption[],
  expressionMap: Record<string, string> = {}
): DockExpressionResolution | null {
  const requested = target?.trim();

  if (!requested || expressions.length === 0) {
    return null;
  }

  const byNormalizedName = new Map<string, string>();
  expressions.forEach((expression) => {
    const key = normalizeExpressionName(expression.name);
    if (key) {
      byNormalizedName.set(key, expression.name);
    }
  });

  const normalizedRequested = normalizeExpressionName(requested);
  const semanticMap = new Map<string, string>();
  Object.entries(expressionMap).forEach(([semantic, rawName]) => {
    const key = normalizeExpressionName(semantic);
    if (key && rawName) semanticMap.set(key, rawName);
  });
  const mappedRequest = expressionMap[requested] ?? semanticMap.get(normalizedRequested) ?? requested;
  const normalizedRequest = normalizeExpressionName(mappedRequest);
  const direct =
    expressions.find((expression) => expression.name === mappedRequest)?.name ??
    (normalizedRequest ? byNormalizedName.get(normalizedRequest) : null);

  if (direct) {
    return {
      requested,
      resolved: direct,
      source: 'direct'
    };
  }

  const candidates = EXPRESSION_ALIASES[normalizedRequest] ?? [];
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeExpressionName(candidate);
    const mappedCandidate = semanticMap.get(normalizedCandidate);
    const resolved = mappedCandidate
      ? byNormalizedName.get(normalizeExpressionName(mappedCandidate))
      : byNormalizedName.get(normalizedCandidate);
    if (resolved) {
      return {
        requested,
        resolved,
        source: 'alias'
      };
    }
  }

  const idleFallback = byNormalizedName.get(normalizeExpressionName(IDLE_EXPRESSION));
  if (idleFallback) {
    return {
      requested,
      resolved: idleFallback,
      source: 'idle_fallback'
    };
  }

  const firstFallback = expressions[0]?.name;
  return firstFallback
    ? {
        requested,
        resolved: firstFallback,
        source: 'first_fallback'
      }
    : null;
}

function startLipSyncMeter(audio: HTMLAudioElement, onLevel: (level: number) => void) {
  const AudioContextCtor =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  let frameId = 0;

  if (!AudioContextCtor) {
    const start = window.performance.now();
    const tick = () => {
      onLevel(audio.paused || audio.ended ? 0 : 0.16 + Math.abs(Math.sin((window.performance.now() - start) / 90)) * 0.24);
      frameId = window.requestAnimationFrame(tick);
    };
    tick();
    return () => {
      window.cancelAnimationFrame(frameId);
      onLevel(0);
    };
  }

  try {
    const context = new AudioContextCtor();
    const source = context.createMediaElementSource(audio);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    const samples = new Uint8Array(analyser.fftSize);
    source.connect(analyser);
    analyser.connect(context.destination);

    const tick = () => {
      analyser.getByteTimeDomainData(samples);
      let total = 0;
      for (let index = 0; index < samples.length; index += 1) {
        const value = ((samples[index] ?? 128) - 128) / 128;
        total += value * value;
      }
      const rms = Math.sqrt(total / samples.length);
      onLevel(audio.paused || audio.ended ? 0 : Math.min(1, rms * 3.8));
      frameId = window.requestAnimationFrame(tick);
    };

    void context.resume().catch(() => undefined);
    tick();

    return () => {
      window.cancelAnimationFrame(frameId);
      source.disconnect();
      analyser.disconnect();
      void context.close().catch(() => undefined);
      onLevel(0);
    };
  } catch (error) {
    console.warn('Falling back to synthetic Live2D lip sync meter:', error);
    const start = window.performance.now();
    const tick = () => {
      onLevel(audio.paused || audio.ended ? 0 : 0.18 + Math.abs(Math.sin((window.performance.now() - start) / 86)) * 0.26);
      frameId = window.requestAnimationFrame(tick);
    };
    tick();
    return () => {
      window.cancelAnimationFrame(frameId);
      onLevel(0);
    };
  }
}

export function Live2DDock({
  externalPlayback = false,
  audioLevelRef,
  audioUrl,
  expression,
  expressionKey,
  idleExpression = IDLE_EXPRESSION,
  stopSignal,
  viewportScale,
  viewportX = 0,
  viewportY = 0,
  viewportResetKey,
  expressionPanelOpen,
  expressionPanelTarget,
  expressionPanelPlacement = 'top',
  onSpeakingChange,
  onExpressionResolved,
  modelUrl,
  expressionMap,
  expressionPresets,
  assignmentTarget = 'control_center',
  onModelContextChange
}: Live2DDockProps) {
  const [dockState, setDockState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [dockMessage, setDockMessage] = useState('Loading the Live2D model...');
  const [expressionLoadState, setExpressionLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [expressions, setExpressions] = useState<ExpressionOption[]>([]);
  const [activeExpressions, setActiveExpressions] = useState<string[]>([]);
  const [isExpressionOverlayVisible, setIsExpressionOverlayVisible] = useState(false);
  const [assignedModel, setAssignedModel] = useState<Live2DModel | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const lastAutoExpressionRef = useRef<string | null>(null);
  const manualExpressionRef = useRef(false);
  const stageReadyRef = useRef(false);
  const lastPlayedAudioRef = useRef<string | null>(null);
  const lastStopSignalRef = useRef<number | undefined>(stopSignal);
  const activeAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioMeterCleanupRef = useRef<(() => void) | null>(null);
  const activeExpressionSet = useMemo(() => new Set(activeExpressions), [activeExpressions]);
  const isManualExpressionPanel = typeof expressionPanelOpen === 'boolean';
  const isExpressionPanelVisible = isManualExpressionPanel
    ? expressionPanelOpen
    : isExpressionOverlayVisible;
  const expressionPanelPositionClass =
    expressionPanelPlacement === 'bottom'
      ? 'bottom-[92px] max-h-[176px] overflow-y-auto'
      : 'top-4';
  const effectiveModelUrl = modelUrl || assignedModel?.model_url || LIVE2D_MODEL_URL;
  const effectiveExpressionPresets = useMemo(
    () => expressionPresets || assignedModel?.expressions || [],
    [assignedModel, expressionPresets]
  );
  const effectiveExpressionMap = useMemo(() => {
    const mappedPresets = Object.fromEntries(
      effectiveExpressionPresets
        .filter((preset) => preset.semantic_key)
        .map((preset) => [preset.semantic_key as string, preset.raw_name])
    );
    return {
      ...mappedPresets,
      ...(assignedModel?.expression_map || {}),
      ...(expressionMap || {})
    };
  }, [assignedModel, effectiveExpressionPresets, expressionMap]);
  const expressionPresetByName = useMemo(() => {
    const presets = new Map<string, ModelExpression>();
    effectiveExpressionPresets.forEach((preset) => {
      presets.set(preset.raw_name, preset);
      presets.set(normalizeExpressionName(preset.raw_name), preset);
    });
    return presets;
  }, [effectiveExpressionPresets]);
  const defaultActiveExpressionNames = useMemo(
    () => effectiveExpressionPresets
      .filter((preset) => preset.default_active)
      .map((preset) => preset.raw_name),
    [effectiveExpressionPresets]
  );
  useEffect(() => {
    if (modelUrl) {
      return;
    }
    let mounted = true;
    const loadAssignment = () => {
      fetchModelAssignment(assignmentTarget).then((model) => {
        if (!mounted) return;
        setAssignedModel(model);
        onModelContextChange?.(model);
      })
      .catch(() => {
        if (!mounted) return;
        setAssignedModel(null);
        onModelContextChange?.(null);
      });
    };
    const handleAssignmentChange = (event: Event) => {
      if (event instanceof StorageEvent && event.key !== 'lily_model_assignment_changed') return;
      const target = (event as CustomEvent<{ target?: string }>).detail?.target;
      if (!target || target === 'global' || target === assignmentTarget) loadAssignment();
    };
    loadAssignment();
    window.addEventListener('lily-model-assignment-changed', handleAssignmentChange);
    window.addEventListener('storage', handleAssignmentChange);
    return () => {
      mounted = false;
      window.removeEventListener('lily-model-assignment-changed', handleAssignmentChange);
      window.removeEventListener('storage', handleAssignmentChange);
    };
  }, [assignmentTarget, modelUrl, onModelContextChange]);

  useEffect(() => {
    setDockState('loading');
    setDockMessage('Loading the Live2D model...');
    setActiveExpressions([]);
    lastAutoExpressionRef.current = null;
    manualExpressionRef.current = false;
    stageReadyRef.current = false;
    const timeout = window.setTimeout(() => {
      if (stageReadyRef.current) return;
      setDockState('error');
      setDockMessage('The model did not finish loading. Reload the page to retry.');
    }, 30000);
    return () => window.clearTimeout(timeout);
  }, [effectiveModelUrl]);

  useEffect(() => {
    const handleStageState = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data;
      if (data?.type !== 'lily-live2d-expression-state' || !Array.isArray(data.active)) return;
      stageReadyRef.current = true;
      setDockState('ready');
      setDockMessage('Live2D model ready.');
      setActiveExpressions(data.active.filter((name: unknown): name is string => typeof name === 'string'));
    };
    window.addEventListener('message', handleStageState);
    return () => window.removeEventListener('message', handleStageState);
  }, [effectiveModelUrl]);

  useEffect(() => {
    let isMounted = true;
    setExpressionLoadState('loading');
    setExpressions([]);

    const loadExpressions = async () => {
      try {
        const response = await fetch(effectiveModelUrl);

        if (!response.ok) {
          throw new Error(`expression manifest request failed: ${response.status}`);
        }

        const data = await response.json();
        const parsed = Array.isArray(data?.FileReferences?.Expressions)
          ? data.FileReferences.Expressions
              .filter((item: unknown) => typeof item === 'object' && item !== null)
              .map((item: Record<string, unknown>) => {
                const name = String(item.Name ?? '').trim();
                const preset = expressionPresetByName.get(name) || expressionPresetByName.get(normalizeExpressionName(name));
                return {
                  name,
                  file: String(item.File ?? '').trim(),
                  displayName: preset?.display_name?.trim() || name,
                  semanticKey: preset?.semantic_key || null
                };
              })
              .filter((item: ExpressionOption) => item.name && item.file)
          : [];

        if (!isMounted) {
          return;
        }

        setExpressions(parsed);
        setExpressionLoadState('ready');
      } catch (error) {
        console.warn('Failed to load Live2D expressions for dashboard controls:', error);

        if (!isMounted) {
          return;
        }

        setExpressions([]);
        setExpressionLoadState('error');
        setActiveExpressions([]);
      }
    };

    void loadExpressions();

    return () => {
      isMounted = false;
    };
  }, [effectiveModelUrl, expressionPresetByName]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const frame = iframeRef.current;
      const targetWindow = frame?.contentWindow;

      if (!frame || !targetWindow) {
        return;
      }

      const rect = frame.getBoundingClientRect();

      targetWindow.postMessage(
        {
          type: 'lily-live2d-cursor',
          clientX: event.clientX - rect.left,
          clientY: event.clientY - rect.top
        },
        window.location.origin
      );
    };

    const resetPointer = () => {
      const targetWindow = iframeRef.current?.contentWindow;

      if (!targetWindow) {
        return;
      }

      targetWindow.postMessage(
        {
          type: 'lily-live2d-cursor-reset'
        },
        window.location.origin
      );
    };

    const handleMouseOut = (event: MouseEvent) => {
      if (event.relatedTarget === null) {
        resetPointer();
      }
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    window.addEventListener('blur', resetPointer);
    window.addEventListener('mouseout', handleMouseOut);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('blur', resetPointer);
      window.removeEventListener('mouseout', handleMouseOut);
    };
  }, []);

  const sendExpressionCommand = useCallback((
    type:
      | 'lily-live2d-set-expression'
      | 'lily-live2d-toggle-expression'
      | 'lily-live2d-clear-expressions'
      | 'lily-live2d-random-expression',
    expressionId?: string
  ) => {
    const targetWindow = iframeRef.current?.contentWindow;

    if (!targetWindow) {
      return;
    }

    if (type === 'lily-live2d-toggle-expression' || type === 'lily-live2d-set-expression') {
      if (!expressionId) {
        return;
      }

      targetWindow.postMessage(
        {
          type,
          expressionId
        },
        window.location.origin
      );
      return;
    }

    targetWindow.postMessage(
      {
        type
      },
      window.location.origin
    );
  }, []);

  const sendLipSyncLevel = useCallback((level: number) => {
    iframeRef.current?.contentWindow?.postMessage(
      {
        type: 'lily-live2d-lipsync-level',
        lipSyncLevel: level
      },
      window.location.origin
    );
  }, []);

  const sendViewportReset = useCallback(() => {
    if (viewportScale === undefined) {
      return;
    }

    iframeRef.current?.contentWindow?.postMessage(
      {
        type: 'lily-live2d-reset-viewport',
        scale: viewportScale,
        x: viewportX,
        y: viewportY
      },
      window.location.origin
    );
  }, [viewportScale, viewportX, viewportY]);

  useEffect(() => {
    if (dockState !== 'ready' || viewportScale === undefined) {
      return;
    }

    sendViewportReset();

    const timers = [
      window.setTimeout(sendViewportReset, 250),
      window.setTimeout(sendViewportReset, 900),
      window.setTimeout(sendViewportReset, 1600)
    ];

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [dockState, sendViewportReset, viewportResetKey, viewportScale]);

  const stopCurrentAudio = useCallback(() => {
    const audio = activeAudioRef.current;
    activeAudioRef.current = null;

    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }

    audioMeterCleanupRef.current?.();
    audioMeterCleanupRef.current = null;
    sendLipSyncLevel(0);
    onSpeakingChange?.(false);

    const resolvedIdleExpression = resolveExpression(
      idleExpression || IDLE_EXPRESSION,
      expressions,
      effectiveExpressionMap
    )?.resolved;
    if (resolvedIdleExpression) {
      sendExpressionCommand('lily-live2d-set-expression', resolvedIdleExpression);
    }
  }, [effectiveExpressionMap, expressions, idleExpression, onSpeakingChange, sendExpressionCommand, sendLipSyncLevel]);

  useEffect(() => {
    if (stopSignal === undefined || lastStopSignalRef.current === stopSignal) {
      return;
    }

    lastStopSignalRef.current = stopSignal;
    stopCurrentAudio();
  }, [stopCurrentAudio, stopSignal]);

  useEffect(() => {
    if (dockState !== 'ready') {
      return;
    }

    const requestedExpression = expression || idleExpression || IDLE_EXPRESSION;
    const expressionResolution = resolveExpression(requestedExpression, expressions, effectiveExpressionMap);
    if (!expressionResolution) {
      return;
    }
    const resolvedExpression = expressionResolution.resolved;

    if (audioUrl && lastPlayedAudioRef.current !== audioUrl) {
      return;
    }

    const resolvedIdleExpression =
      resolveExpression(idleExpression || IDLE_EXPRESSION, expressions, effectiveExpressionMap)?.resolved || resolvedExpression;
    const fingerprint = `${expressionKey ?? 'latest'}:${resolvedExpression}:idle:${resolvedIdleExpression}`;
    if (lastAutoExpressionRef.current === fingerprint) {
      return;
    }

    lastAutoExpressionRef.current = fingerprint;
    manualExpressionRef.current = false;
    onExpressionResolved?.(expressionResolution);
    sendExpressionCommand('lily-live2d-set-expression', resolvedExpression);

    const retryTimers = [
      window.setTimeout(() => { if (!manualExpressionRef.current) sendExpressionCommand('lily-live2d-set-expression', resolvedExpression); }, 700),
      window.setTimeout(() => { if (!manualExpressionRef.current) sendExpressionCommand('lily-live2d-set-expression', resolvedExpression); }, 1600)
    ];
    const decayTimer = window.setTimeout(() => {
      if (manualExpressionRef.current || !resolvedIdleExpression || resolvedIdleExpression === resolvedExpression) {
        return;
      }

      sendExpressionCommand('lily-live2d-set-expression', resolvedIdleExpression);
    }, EXPRESSION_DECAY_MS);

    return () => {
      retryTimers.forEach((timer) => window.clearTimeout(timer));
      window.clearTimeout(decayTimer);
    };
  }, [audioUrl, dockState, effectiveExpressionMap, expression, expressionKey, expressions, idleExpression, onExpressionResolved, sendExpressionCommand]);

  useEffect(() => {
    if (externalPlayback || dockState !== 'ready' || !audioUrl || lastPlayedAudioRef.current === audioUrl) {
      return;
    }

    stopCurrentAudio();

    lastPlayedAudioRef.current = audioUrl;
    const audio = new Audio(audioUrl);
    audio.crossOrigin = 'anonymous';
    audio.volume = 1;
    activeAudioRef.current = audio;
    let decayTimer: number | null = null;

    const applySyncedExpression = () => {
      const requestedExpression = expression || idleExpression || IDLE_EXPRESSION;
      const expressionResolution = resolveExpression(requestedExpression, expressions, effectiveExpressionMap);
      if (!expressionResolution) {
        return;
      }
      const resolvedExpression = expressionResolution.resolved;

      lastAutoExpressionRef.current = `${expressionKey ?? 'latest'}:${resolvedExpression}`;
      manualExpressionRef.current = false;
      onExpressionResolved?.(expressionResolution);
      sendExpressionCommand('lily-live2d-set-expression', resolvedExpression);
    };

    const stopSpeaking = () => {
      if (activeAudioRef.current === audio) {
        activeAudioRef.current = null;
      }
      audioMeterCleanupRef.current?.();
      audioMeterCleanupRef.current = null;
      sendLipSyncLevel(0);
      onSpeakingChange?.(false);
    };

    const startSpeaking = () => {
      applySyncedExpression();
      onSpeakingChange?.(true);
      audioMeterCleanupRef.current = startLipSyncMeter(audio, sendLipSyncLevel);
      decayTimer = window.setTimeout(() => {
        const resolvedIdleExpression = resolveExpression(
          idleExpression || IDLE_EXPRESSION,
          expressions,
          effectiveExpressionMap
        )?.resolved;
        if (manualExpressionRef.current || !resolvedIdleExpression) {
          return;
        }

        sendExpressionCommand('lily-live2d-set-expression', resolvedIdleExpression);
      }, EXPRESSION_DECAY_MS);
    };

    audio.addEventListener('playing', startSpeaking, { once: true });
    audio.addEventListener('ended', stopSpeaking, { once: true });
    audio.addEventListener('pause', stopSpeaking, { once: true });

    void audio.play().catch((error) => {
      console.warn('Dashboard Live2D audio playback was blocked or failed:', error);
      applySyncedExpression();
      stopSpeaking();
    });
 
    return () => {
      if (decayTimer !== null) {
        window.clearTimeout(decayTimer);
      }
      audio.removeEventListener('playing', startSpeaking);
      audio.removeEventListener('ended', stopSpeaking);
      audio.removeEventListener('pause', stopSpeaking);
      stopSpeaking();
      audio.pause();
    };
  }, [
    externalPlayback,
    audioUrl,
    dockState,
    expression,
    expressionKey,
    expressions,
    effectiveExpressionMap,
    idleExpression,
    onExpressionResolved,
    onSpeakingChange,
    sendExpressionCommand,
    sendLipSyncLevel,
    stopCurrentAudio,
  ]);

  useEffect(() => {
    return () => {
      const audio = activeAudioRef.current;
      activeAudioRef.current = null;

      if (audio) {
        audio.pause();
      }

      audioMeterCleanupRef.current?.();
      audioMeterCleanupRef.current = null;
      sendLipSyncLevel(0);
      onSpeakingChange?.(false);
    };
  }, [onSpeakingChange, sendLipSyncLevel]);

  useEffect(() => {
    if (!externalPlayback || !audioLevelRef || dockState !== 'ready') return;
    let frame = 0;
    const tick = () => {
      sendLipSyncLevel(audioLevelRef.current);
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => { cancelAnimationFrame(frame); sendLipSyncLevel(0); };
  }, [externalPlayback, audioLevelRef, dockState, sendLipSyncLevel]);

  const toggleExpression = (expressionId: string) => {
    manualExpressionRef.current = true;
    sendExpressionCommand('lily-live2d-toggle-expression', expressionId);
  };

  const applyRandomExpression = () => {
    const candidates = expressions.filter((item) => !defaultActiveExpressionNames.includes(item.name));
    if (candidates.length === 0) {
      return;
    }

    const picked = candidates[Math.floor(Math.random() * candidates.length)];

    if (!picked) {
      return;
    }

    manualExpressionRef.current = true;
    sendExpressionCommand('lily-live2d-set-expression', picked.name);
  };

  const clearExpressions = () => {
    manualExpressionRef.current = true;
    sendExpressionCommand('lily-live2d-clear-expressions');
  };

  const expressionControls = (
    <div className="lily-expression-controls">
      {expressionLoadState === 'error' || dockState === 'error' ? (
        <p role="alert">{dockState === 'error' ? dockMessage : 'Could not load the expression list. Reload the page to retry.'}</p>
      ) : expressionLoadState === 'loading' || dockState === 'loading' ? (
        <p role="status">Loading model expressions...</p>
      ) : expressions.length === 0 ? (
        <p>This model has no expression presets.</p>
      ) : (
        <>
          <p className="lily-expression-active" role="status">Active: <b>{activeExpressions.map((name) => expressions.find((item) => item.name === name)?.displayName || name).join(', ') || 'None'}</b></p>
          <div className="lily-expression-options" role="group" aria-label="Model expressions">
            {expressions.map((item) => (
              <button key={item.name} type="button" aria-pressed={activeExpressionSet.has(item.name)} onClick={() => toggleExpression(item.name)}>{item.displayName}</button>
            ))}
          </div>
          <div className="lily-expression-actions">
            <button type="button" onClick={clearExpressions}>Clear</button>
            <button type="button" onClick={applyRandomExpression} disabled={expressions.every((item) => defaultActiveExpressionNames.includes(item.name))}>Random</button>
          </div>
          <p className="lily-expression-hint">Local preview. Lily's next response restores automatic expressions.</p>
        </>
      )}
    </div>
  );

  return (
    <div
      className="relative h-[96%] w-[94%] overflow-hidden rounded-[28px] border border-dashed border-[#d89ebc]/50 bg-white/18 shadow-[0_20px_48px_rgba(122,76,108,0.16)]"
      onMouseEnter={() => {
        if (!isManualExpressionPanel) {
          setIsExpressionOverlayVisible(true);
        }
      }}
      onMouseLeave={() => {
        if (!isManualExpressionPanel) {
          setIsExpressionOverlayVisible(false);
        }
      }}
    >
      <iframe
        key={effectiveModelUrl}
        ref={iframeRef}
        title="Lily Live2D Stage"
        src={`/live2d-stage.html?model=${encodeURIComponent(effectiveModelUrl)}`}
        className="lily-presence-stage absolute inset-0 h-full w-full border-0"
        allow="autoplay"
        onLoad={() => {
          setDockMessage('Loading the Live2D model...');
        }}
        onError={() => {
          setDockState('error');
          setDockMessage('Stage Live2D failed to load.');
        }}
      />

      {dockState !== 'ready' ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
          {dockState === 'loading' ? (
            <LoaderCircle className="mb-4 h-10 w-10 animate-spin text-[#c06792]" />
          ) : (
            <Sparkles className="mb-4 h-10 w-10 text-[#c06792]" />
          )}
          <p className="text-[24px] font-semibold tracking-[-0.04em] text-[#4b2d3f]">Live2D Lily Dock</p>
          <p className="mt-3 max-w-[260px] text-[13px] leading-6 text-[#76586b]">{dockMessage}</p>
        </div>
      ) : null}

      {expressionPanelTarget ? createPortal(expressionControls, expressionPanelTarget) : null}

      {!expressionPanelTarget && dockState === 'ready' && expressions.length > 0 && expressionPanelOpen !== false ? (
        <div
          className={`absolute left-4 right-4 ${expressionPanelPositionClass} z-20 rounded-[20px] border border-white/55 bg-white/78 p-3 shadow-[0_18px_40px_rgba(64,31,51,0.14)] backdrop-blur-xl transition-all duration-200 ${
            isExpressionPanelVisible
              ? 'pointer-events-auto translate-y-0 opacity-100'
              : `pointer-events-none opacity-0 ${
                  expressionPanelPlacement === 'bottom' ? 'translate-y-2' : '-translate-y-2'
                }`
          }`}
        >
          <div className="flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-[#b35d88]" />
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#8e5e77]">Expression</p>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {expressions.map((expression) => {
              const isActive = activeExpressionSet.has(expression.name);

              return (
                <button
                  key={expression.name}
                  type="button"
                  onClick={() => toggleExpression(expression.name)}
                  className={`rounded-full border px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] transition ${
                    isActive
                      ? 'border-[#6a3758] bg-[#5c2f4d] text-white shadow-[0_10px_24px_rgba(80,33,60,0.2)]'
                      : 'border-[#efcade] bg-white/90 text-[#7f556c] hover:border-[#deabc7] hover:text-[#5c2f4d]'
                  }`}
                >
                  {expression.displayName}
                </button>
              );
            })}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={clearExpressions}
              className="rounded-full border border-[#efcade] bg-white/90 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7f556c] transition hover:border-[#deabc7] hover:text-[#5c2f4d]"
            >
              Clear
            </button>

            <button
              type="button"
              onClick={applyRandomExpression}
              className="rounded-full border border-[#efcade] bg-white/90 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7f556c] transition hover:border-[#deabc7] hover:text-[#5c2f4d]"
            >
              Random
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
