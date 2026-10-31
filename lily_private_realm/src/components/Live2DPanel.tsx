import { type Ref, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { loadPrivateModelAssignment, type PrivateModelAssignment } from '../realm/modelAssignment'

type StageParamValue = string | number | boolean | undefined
const EXPRESSION_DECAY_MS = 9000
const IDLE_EXPRESSION = 'Blush'
const LIVE2D_MODEL_URL = import.meta.env.VITE_LIVE2D_MODEL_URL ?? '/live2d/haru/Haru.model3.json'

type ExpressionOption = {
  name: string
  file: string
}

export type PrivateExpressionResolution = {
  requested: string
  resolved: string
  source: 'direct' | 'alias' | 'idle_fallback' | 'first_fallback'
}

interface Live2DPanelProps {
  className?: string
  expression?: string | null
  expressionKey?: string | number | null
  idleExpression?: string | null
  lipSyncLevel?: number
  iframeRef?: Ref<HTMLIFrameElement>
  stageParams?: Record<string, StageParamValue>
  onExpressionResolved?: (resolution: PrivateExpressionResolution) => void
}

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
  serious: ['Angry', 'F05'],
}

function normalizeExpressionName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function resolveExpression(
  target: string | null | undefined,
  expressions: ExpressionOption[],
  expressionMap: Record<string, string> = {},
): PrivateExpressionResolution | null {
  const requested = target?.trim()

  if (!requested || expressions.length === 0) {
    return null
  }

  const byNormalizedName = new Map<string, string>()
  expressions.forEach((expression) => {
    const key = normalizeExpressionName(expression.name)
    if (key) {
      byNormalizedName.set(key, expression.name)
    }
  })

  const mappedRequest = expressionMap[requested] ?? requested
  const normalizedRequest = normalizeExpressionName(mappedRequest)
  const direct =
    expressions.find((expression) => expression.name === mappedRequest)?.name ||
    (normalizedRequest ? byNormalizedName.get(normalizedRequest) : '')

  if (direct) {
    return {
      requested,
      resolved: direct,
      source: 'direct',
    }
  }

  const candidates = EXPRESSION_ALIASES[normalizedRequest] || []
  for (const candidate of candidates) {
    const resolved = byNormalizedName.get(normalizeExpressionName(candidate))
    if (resolved) {
      return {
        requested,
        resolved,
        source: 'alias',
      }
    }
  }

  const idleFallback = byNormalizedName.get(normalizeExpressionName(IDLE_EXPRESSION))
  if (idleFallback) {
    return {
      requested,
      resolved: idleFallback,
      source: 'idle_fallback',
    }
  }

  const firstFallback = expressions[0]?.name
  return firstFallback
    ? {
        requested,
        resolved: firstFallback,
        source: 'first_fallback',
      }
    : null
}

function buildStageSrc(stageParams?: Record<string, StageParamValue>, modelUrl?: string) {
  const params = new URLSearchParams()

  if (modelUrl) {
    params.set('model', modelUrl)
  }

  Object.entries(stageParams || {}).forEach(([key, value]) => {
    if (value === undefined) {
      return
    }

    params.set(key, String(value))
  })

  const query = params.toString()
  return query ? `/live2d-stage.html?${query}` : '/live2d-stage.html'
}

export default function Live2DPanel({
  className = '',
  expression,
  expressionKey,
  idleExpression = IDLE_EXPRESSION,
  lipSyncLevel = 0,
  iframeRef,
  stageParams,
  onExpressionResolved,
}: Live2DPanelProps) {
  const localIframeRef = useRef<HTMLIFrameElement>(null)
  const lastExpressionRef = useRef<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [expressions, setExpressions] = useState<ExpressionOption[]>([])
  const [assignedModel, setAssignedModel] = useState<PrivateModelAssignment | null>(null)
  const effectiveModelUrl = assignedModel?.model_url || LIVE2D_MODEL_URL
  const expressionMap = useMemo(() => assignedModel?.expression_map || {}, [assignedModel])
  const stageSrc = buildStageSrc(stageParams, effectiveModelUrl)

  useImperativeHandle(iframeRef, () => localIframeRef.current as HTMLIFrameElement, [])

  useEffect(() => {
    let active = true
    const loadAssignment = () => {
      loadPrivateModelAssignment().then((model) => {
        if (active) setAssignedModel(model)
      })
    }
    const handleAssignmentChange = (event: Event) => {
      if (event instanceof StorageEvent && event.key !== 'lily_model_assignment_changed') return
      const target = (event as CustomEvent<{ target?: string }>).detail?.target
      if (!target || target === 'global' || target === 'private_realm') loadAssignment()
    }
    loadAssignment()
    window.addEventListener('storage', handleAssignmentChange)
    window.addEventListener('lily-model-assignment-changed', handleAssignmentChange)
    return () => {
      active = false
      window.removeEventListener('storage', handleAssignmentChange)
      window.removeEventListener('lily-model-assignment-changed', handleAssignmentChange)
    }
  }, [])

  useEffect(() => {
    const iframe = localIframeRef.current
    if (!iframe) return

    const onLoad = () => setStatus('ready')
    const onError = () => setStatus('error')
    iframe.addEventListener('load', onLoad)
    iframe.addEventListener('error', onError)

    // Cursor bridge: forward pointer from parent window to iframe
    const onPointerMove = (e: PointerEvent) => {
      if (!iframe.contentWindow) return
      const rect = iframe.getBoundingClientRect()
      iframe.contentWindow.postMessage(
        {
          type: 'lily-live2d-cursor',
          clientX: e.clientX - rect.left,
          clientY: e.clientY - rect.top,
        },
        window.location.origin
      )
    }

    const onPointerLeave = () => {
      iframe.contentWindow?.postMessage(
        { type: 'lily-live2d-cursor-reset' },
        window.location.origin
      )
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerout', onPointerLeave)
    const onVisibilityChange = () => {
      if (document.hidden) onPointerLeave()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      iframe.removeEventListener('load', onLoad)
      iframe.removeEventListener('error', onError)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerout', onPointerLeave)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  useEffect(() => {
    let active = true

    async function loadExpressions() {
      try {
        const response = await fetch(effectiveModelUrl)
        if (!response.ok) {
          throw new Error(`expression manifest request failed: ${response.status}`)
        }

        const data = await response.json()
        const parsed = Array.isArray(data?.FileReferences?.Expressions)
          ? data.FileReferences.Expressions
              .filter((item: unknown) => typeof item === 'object' && item !== null)
              .map((item: Record<string, unknown>) => ({
                name: String(item.Name ?? '').trim(),
                file: String(item.File ?? '').trim(),
              }))
              .filter((item: ExpressionOption) => item.name && item.file)
          : []

        if (active) {
          setExpressions(parsed)
        }
      } catch (error) {
        console.warn('Failed to load Private Realm Live2D expressions:', error)
        if (active) {
          setExpressions([])
        }
      }
    }

    void loadExpressions()

    return () => {
      active = false
    }
  }, [effectiveModelUrl])

  useEffect(() => {
    if (status !== 'ready') return

    const resolution = resolveExpression(expression, expressions, expressionMap)
    if (!resolution) return

    const expressionId = resolution.resolved

    const resolvedIdleExpression =
      resolveExpression(idleExpression || IDLE_EXPRESSION, expressions, expressionMap)?.resolved || expressionId
    const fingerprint = `${expressionKey ?? 'latest'}:${expressionId}:idle:${resolvedIdleExpression}`
    if (lastExpressionRef.current === fingerprint) return

    lastExpressionRef.current = fingerprint
    onExpressionResolved?.(resolution)

    const postExpression = () => {
      localIframeRef.current?.contentWindow?.postMessage(
        { type: 'lily-live2d-set-expression', expressionId },
        window.location.origin,
      )
    }

    postExpression()
    const retryTimers = [
      window.setTimeout(postExpression, 700),
      window.setTimeout(postExpression, 1600),
    ]
    const decayTimer = window.setTimeout(() => {
      localIframeRef.current?.contentWindow?.postMessage(
        {
          type: 'lily-live2d-set-expression',
          expressionId: resolvedIdleExpression,
        },
        window.location.origin,
      )
    }, EXPRESSION_DECAY_MS)

    return () => {
      retryTimers.forEach((timer) => window.clearTimeout(timer))
      window.clearTimeout(decayTimer)
    }
  }, [expression, expressionKey, expressionMap, expressions, idleExpression, onExpressionResolved, status])

  useEffect(() => {
    if (status !== 'ready') return

    localIframeRef.current?.contentWindow?.postMessage(
      {
        type: 'lily-live2d-lipsync-level',
        lipSyncLevel,
      },
      window.location.origin,
    )
  }, [lipSyncLevel, status])

  return (
    <div className={`live2d-panel ${className}`}>
      {status === 'loading' && (
        <div className="live2d-panel__loader">
          <div className="live2d-panel__spinner" />
        </div>
      )}
      {status === 'error' && (
        <div className="live2d-panel__error">
          <p>Live2D failed to load</p>
        </div>
      )}
      <iframe
        key={stageSrc}
        ref={localIframeRef}
        src={stageSrc}
        className="live2d-panel__iframe"
        title="Lily Live2D"
        allow="autoplay"
      />
    </div>
  )
}
