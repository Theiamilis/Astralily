import { useEffect, useRef, useState } from 'react'
import Live2DPanel from '../components/Live2DPanel'
import { usePrivateRealm } from '../realm/usePrivateRealm'
import './PrivateRealmPetMode.css'

const PET_POSITION_KEY = 'lily_private_realm_pet_position_v1'
const PET_WIDTH = 420
const PET_HEIGHT = 720
const PET_MARGIN = 12

type PetPosition = {
  x: number
  y: number
}

type DragState = {
  pointerId: number
  startX: number
  startY: number
  originX: number
  originY: number
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function constrainPosition(position: PetPosition): PetPosition {
  const maxX = Math.max(PET_MARGIN, window.innerWidth - PET_WIDTH - PET_MARGIN)
  const maxY = Math.max(PET_MARGIN, window.innerHeight - PET_HEIGHT - PET_MARGIN)

  return {
    x: clamp(position.x, PET_MARGIN, maxX),
    y: clamp(position.y, PET_MARGIN, maxY),
  }
}

function readPetPosition(): PetPosition {
  const raw = localStorage.getItem(PET_POSITION_KEY)

  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<PetPosition>
      if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
        return constrainPosition({
          x: Number(parsed.x),
          y: Number(parsed.y),
        })
      }
    } catch {
      localStorage.removeItem(PET_POSITION_KEY)
    }
  }

  return constrainPosition({
    x: Math.max(PET_MARGIN, window.innerWidth - PET_WIDTH - 36),
    y: Math.max(PET_MARGIN, window.innerHeight - PET_HEIGHT - 28),
  })
}

export default function PrivateRealmPetMode() {
  const realm = usePrivateRealm()
  const [position, setPosition] = useState<PetPosition>(() => readPetPosition())
  const dragStateRef = useRef<DragState | null>(null)
  const statusTone = realm.healthSummary.coreTone === 'good' && realm.healthSummary.voiceTone === 'good'
    ? 'ready'
    : realm.health
      ? 'limited'
      : 'offline'

  useEffect(() => {
    localStorage.setItem(PET_POSITION_KEY, JSON.stringify(position))
  }, [position])

  useEffect(() => {
    const handleResize = () => {
      setPosition((current) => constrainPosition(current))
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current
      if (!dragState || event.pointerId !== dragState.pointerId) return

      setPosition(constrainPosition({
        x: dragState.originX + event.clientX - dragState.startX,
        y: dragState.originY + event.clientY - dragState.startY,
      }))
    }

    const handlePointerUp = (event: PointerEvent) => {
      if (dragStateRef.current?.pointerId === event.pointerId) {
        dragStateRef.current = null
      }
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [])

  return (
    <main className={`pet-realm pet-realm--${statusTone}`}>
      <audio ref={realm.audioRef} hidden />

      <section
        className="pet-shell"
        style={{ left: position.x, top: position.y }}
        aria-label="Lily pet companion"
      >
        <header
          className="pet-handle"
          onPointerDown={(event) => {
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            dragStateRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              originX: position.x,
              originY: position.y,
            }
          }}
        >
          <div>
            <span>Lily Pet</span>
            <strong>{realm.voiceStatus.label}</strong>
          </div>
          <i aria-hidden="true" />
        </header>

        <div className="pet-stage">
          <Live2DPanel
            className="pet-live2d"
            expression={realm.latestExpression}
            expressionKey={realm.latestExpressionKey}
            idleExpression={realm.moodExpression}
            lipSyncLevel={realm.lipSyncLevel}
            stageParams={{ fitMode: 'sweet-room', viewScale: 0.82, viewY: -0.06 }}
            onExpressionResolved={realm.setExpressionResolution}
          />
        </div>

        <div className="pet-bubble" aria-live="polite">
          <span>{realm.latestLilyLine ? 'Lily' : `${realm.voiceStatus.label} / ${realm.ownerPresence.label || 'Available'}`}</span>
          <p>{realm.latestLilyLine || realm.chatError || realm.voiceStatus.detail}</p>
        </div>

        <form
          className="pet-chat"
          onSubmit={(event) => {
            event.preventDefault()
            realm.sendMessage()
          }}
        >
          <input
            value={realm.input}
            onChange={(event) => realm.setInput(event.target.value)}
            onKeyDown={realm.handleKeyDown}
            placeholder="Quick chat..."
            disabled={realm.isSending}
          />
          <button type="submit" disabled={!realm.input.trim() || realm.isSending}>
            Send
          </button>
        </form>

        <div className="pet-controls" aria-label="Pet quick controls">
          <button
            type="button"
            className={realm.isVoiceListening ? 'is-listening' : ''}
            onPointerDown={(event) => {
              event.preventDefault()
              event.currentTarget.setPointerCapture(event.pointerId)
              realm.startPushToTalk()
            }}
            onPointerUp={(event) => {
              event.preventDefault()
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId)
              }
              realm.finishPushToTalk()
            }}
            onPointerCancel={realm.finishPushToTalk}
            onLostPointerCapture={realm.finishPushToTalk}
          >
            {realm.isVoiceListening ? 'Listening' : 'Talk'}
          </button>
          <button type="button" onClick={realm.stopCurrentVoice}>
            Stop Voice
          </button>
        </div>

        <footer className="pet-status">
          <span className={`is-${realm.healthSummary.coreTone}`}>
            Core <strong>{realm.healthSummary.coreLabel}</strong>
          </span>
          <span className={`is-${realm.healthSummary.voiceTone}`}>
            Voice <strong>{realm.healthSummary.voiceLabel}</strong>
          </span>
          <span>
            Face <strong>{realm.expressionResolution?.resolved || 'Blush'}</strong>
          </span>
          <span>
            Presence <strong>{realm.ownerPresence.label || 'Available'}</strong>
          </span>
        </footer>
      </section>
    </main>
  )
}
