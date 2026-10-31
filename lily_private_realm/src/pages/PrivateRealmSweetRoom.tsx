import { useEffect, useRef, useState } from 'react'
import Live2DPanel from '../components/Live2DPanel'
import { REALM_MOODS, usePrivateRealm } from '../realm/usePrivateRealm'
import type { ChatMessage, RealmMoodId } from '../realm/usePrivateRealm'
import './PrivateRealmSweetRoom.css'

const expressionPresets = [
  { id: 'Side Bangs', label: 'Side Bangs' },
  { id: 'Back Hair', label: 'Back Hair' },
  { id: 'Sparkle A', label: 'Sparkle A' },
  { id: 'Sparkle B', label: 'Sparkle B' },
  { id: 'Crying', label: 'Crying' },
  { id: 'Sparkle Mood', label: 'Sparkle Mood' },
  { id: 'Gloomy', label: 'Gloomy' },
  { id: 'Blush', label: 'Blush' },
  { id: 'Mask', label: 'Mask' },
  { id: 'Sweat', label: 'Sweat' },
  { id: 'Love', label: 'Love' },
  { id: 'Shy', label: 'Shy' },
  { id: 'Angry', label: 'Angry' },
  { id: 'Soft Love', label: 'Soft Love' },
  { id: 'Head Tilt', label: 'Head Tilt' },
]

const moodExpressionMap: Partial<Record<RealmMoodId, string[]>> = {
  heart: ['Love', 'Soft Love'],
  smile: ['Sparkle Mood'],
  crown: ['Sparkle A', 'Head Tilt'],
  tune: ['Sparkle B'],
  talk: [],
}

function formatMessageTime(timestamp?: string) {
  if (!timestamp) return 'now'
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return 'saved'

  return date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function SweetMessage({ message }: { message: ChatMessage }) {
  const isUser = message.sender === 'user'

  return (
    <article className={`sweet-chat-message ${isUser ? 'is-owner' : 'is-lily'}`}>
      {!isUser && <div className="sweet-avatar">L</div>}
      <div>
        <strong>{isUser ? 'Lily User' : 'Lily'}</strong>
        <p>{message.text}</p>
        <span>{formatMessageTime(message.timestamp)}</span>
      </div>
    </article>
  )
}

export default function PrivateRealmSweetRoom() {
  const realm = usePrivateRealm()
  const live2dFrameRef = useRef<HTMLIFrameElement>(null)
  const [isUiHidden, setIsUiHidden] = useState(false)
  const [isExpressionPanelOpen, setIsExpressionPanelOpen] = useState(false)
  const [activeExpressions, setActiveExpressions] = useState<string[]>([])
  const messages = realm.messages.slice(-12)
  const isCoreOffline = !realm.health

  function postLive2D(message: Record<string, string>) {
    live2dFrameRef.current?.contentWindow?.postMessage(message, window.location.origin)
  }

  useEffect(() => {
    const expressions = moodExpressionMap[realm.activeMoodId] || []
    const targetWindow = live2dFrameRef.current?.contentWindow

    targetWindow?.postMessage({ type: 'lily-live2d-clear-expressions' }, window.location.origin)
    expressions.forEach((expressionId) => {
      targetWindow?.postMessage({ type: 'lily-live2d-toggle-expression', expressionId }, window.location.origin)
    })
    setActiveExpressions(expressions)
    if (expressions.length) {
      setIsExpressionPanelOpen(false)
    }
  }, [realm.activeMoodId])

  useEffect(() => {
    if (!realm.latestExpression) return

    setActiveExpressions([realm.latestExpression])
    setIsExpressionPanelOpen(false)
    const timer = window.setTimeout(() => {
      setActiveExpressions(['Blush'])
    }, 9000)

    return () => window.clearTimeout(timer)
  }, [realm.latestExpression, realm.latestExpressionKey])

  function toggleExpression(expressionId: string) {
    postLive2D({ type: 'lily-live2d-toggle-expression', expressionId })
    setActiveExpressions((current) => (
      current.includes(expressionId)
        ? current.filter((id) => id !== expressionId)
        : [...current, expressionId]
    ))
  }

  function clearExpressions() {
    postLive2D({ type: 'lily-live2d-clear-expressions' })
    setActiveExpressions([])
  }

  function randomExpression() {
    const preset = expressionPresets[Math.floor(Math.random() * expressionPresets.length)]
    if (!preset) return

    postLive2D({ type: 'lily-live2d-set-expression', expressionId: preset.id })
    setActiveExpressions([preset.id])
  }

  return (
    <main className={`sweet-room ${isUiHidden ? 'is-ui-hidden' : ''} ${isCoreOffline ? 'is-core-offline' : ''}`}>
      <audio ref={realm.audioRef} hidden />

      <button
        type="button"
        className="sweet-ui-toggle"
        aria-pressed={!isUiHidden}
        onClick={() => setIsUiHidden((isHidden) => !isHidden)}
      >
        {isUiHidden ? 'Show UI' : 'Hide UI'}
      </button>

      <aside className="sweet-sidebar">
        <div className="sweet-brand">
          <span>Lily Console</span>
          <h1>Lily</h1>
          <p>Live2D</p>
        </div>
        <nav className="sweet-nav" aria-label="Private realm navigation">
          <button type="button" className="is-active">Chat</button>
          <button type="button">Gallery</button>
          <button type="button">Settings</button>
          <button type="button">Help</button>
        </nav>
        <div className="sweet-affinity">
          <span>Closeness</span>
          <strong>Lv. 3</strong>
          <div><i /></div>
          <p>650 / 1000</p>
        </div>
      </aside>

      <section className="sweet-chat-card">
        <header>
          <h2>Chat</h2>
          <span className={`sweet-chat-mode is-${realm.voiceStatus.tone}`}>
            {realm.voiceStatus.label}
          </span>
        </header>
        <div className={`sweet-chat-status is-${realm.voiceStatus.tone}`} aria-live="polite">
          <strong>{realm.voiceStatus.label}</strong>
          <span>{realm.chatError || realm.voiceStatus.detail}</span>
        </div>
        <div className="sweet-chat-list">
          {messages.length === 0 ? (
            <div className="sweet-chat-empty">
              <strong>Quiet room ready.</strong>
              <p>Start chatting whenever you want. Real backend messages will appear here.</p>
            </div>
          ) : (
            messages.map((message, index) => (
              <SweetMessage key={`${message.sender}-${index}-${message.text}`} message={message} />
            ))
          )}
          {realm.isSending && (
            <article className="sweet-chat-message is-lily">
              <div className="sweet-avatar">L</div>
              <div>
                <strong>Lily</strong>
                <p>{realm.voiceStatus.id === 'thinking' ? 'thinking through it...' : 'working softly...'}</p>
                <span>live</span>
              </div>
            </article>
          )}
          <div ref={realm.chatEndRef} />
        </div>
        <form
          className="sweet-composer"
          onSubmit={(event) => {
            event.preventDefault()
            realm.sendMessage()
          }}
        >
          <input
            value={realm.input}
            onChange={(event) => realm.setInput(event.target.value)}
            onKeyDown={realm.handleKeyDown}
            placeholder="Type a message..."
            disabled={realm.isSending}
          />
          <button type="submit" disabled={!realm.input.trim() || realm.isSending}>
            {realm.isSending ? '...' : 'Send'}
          </button>
        </form>
      </section>

      <section className="sweet-stage">
        <div className="sweet-bubble-field" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
        <div className="sweet-orbit" />
        <Live2DPanel
          className="sweet-live2d"
          expression={realm.latestExpression}
          expressionKey={realm.latestExpressionKey}
          idleExpression={realm.moodExpression}
          lipSyncLevel={realm.lipSyncLevel}
          iframeRef={live2dFrameRef}
          stageParams={{ fitMode: 'sweet-room', viewScale: 0.76, viewY: -0.08 }}
          onExpressionResolved={realm.setExpressionResolution}
        />
        {realm.latestLilyLine && (
          <div className="sweet-stage-caption" aria-live="polite">
            <span>{realm.activeMood.title}</span>
            <p>{realm.latestLilyLine}</p>
          </div>
        )}
        <button
          type="button"
          className="sweet-voice-stop"
          onClick={realm.stopCurrentVoice}
        >
          Stop Voice
        </button>
        <button
          type="button"
          className="sweet-expression-toggle"
          aria-expanded={isExpressionPanelOpen}
          aria-controls="sweet-expression-panel"
          onClick={() => setIsExpressionPanelOpen((isOpen) => !isOpen)}
        >
          {isExpressionPanelOpen ? 'Hide Expression' : 'Expression'}
        </button>
        <div
          id="sweet-expression-panel"
          className={`sweet-expression-panel ${isExpressionPanelOpen ? 'is-open' : 'is-hidden'}`}
          aria-label="Live2D expression controls"
        >
          <header>
            <span>Expression</span>
            <strong>{activeExpressions.length ? `${activeExpressions.length} active` : 'neutral'}</strong>
            <button type="button" onClick={() => setIsExpressionPanelOpen(false)}>
              Hide
            </button>
          </header>
          <div className="sweet-expression-grid">
            {expressionPresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={activeExpressions.includes(preset.id) ? 'is-active' : ''}
                aria-pressed={activeExpressions.includes(preset.id)}
                onClick={() => toggleExpression(preset.id)}
              >
                {preset.label}
              </button>
            ))}
            <button type="button" className="is-utility" onClick={clearExpressions}>
              Clear
            </button>
            <button type="button" className="is-utility" onClick={randomExpression}>
              Random
            </button>
          </div>
          <div className="sweet-expression-debug" aria-label="Expression debug">
            <span>Emotion <strong>{realm.latestEmotion || 'neutral'}</strong></span>
            <span>Requested <strong>{realm.expressionResolution?.requested || realm.latestExpression || 'Blush'}</strong></span>
            <span>Resolved <strong>{realm.expressionResolution?.resolved || 'Blush'}</strong></span>
            <span>Source <strong>{realm.latestExpressionSource || 'standby'}</strong></span>
            <span>Resolver <strong>{realm.expressionResolution?.source || 'standby'}</strong></span>
          </div>
        </div>
        <div className="sweet-dock" aria-label="Lily mood selector">
          {REALM_MOODS.map((mood) => (
            <button
              key={mood.id}
              type="button"
              className={[
                mood.id === 'talk' ? 'is-primary' : '',
                mood.id !== 'talk' && mood.id === realm.activeMoodId ? 'is-selected' : '',
                mood.id === 'talk' && realm.isVoiceListening ? 'is-listening' : '',
              ].filter(Boolean).join(' ')}
              aria-pressed={mood.id === 'talk' ? realm.isVoiceListening : mood.id === realm.activeMoodId}
              title={mood.id === 'talk' ? 'Hold to talk' : mood.title}
              onPointerDown={(event) => {
                if (mood.id === 'talk') {
                  event.preventDefault()
                  event.currentTarget.setPointerCapture(event.pointerId)
                  realm.startPushToTalk()
                }
              }}
              onPointerUp={(event) => {
                if (mood.id === 'talk') {
                  event.preventDefault()
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId)
                  }
                  realm.finishPushToTalk()
                }
              }}
              onPointerCancel={() => {
                if (mood.id === 'talk') {
                  realm.finishPushToTalk()
                }
              }}
              onLostPointerCapture={() => {
                if (mood.id === 'talk') {
                  realm.finishPushToTalk()
                }
              }}
              onKeyDown={(event) => {
                if (mood.id === 'talk' && (event.key === ' ' || event.key === 'Enter') && !event.repeat) {
                  event.preventDefault()
                  realm.startPushToTalk()
                }
              }}
              onKeyUp={(event) => {
                if (mood.id === 'talk' && (event.key === ' ' || event.key === 'Enter')) {
                  event.preventDefault()
                  realm.finishPushToTalk()
                }
              }}
              onClick={(event) => {
                if (mood.id === 'talk') {
                  event.preventDefault()
                  return
                }
                realm.selectMood(mood.id)
              }}
            >
              {mood.label}
            </button>
          ))}
        </div>
      </section>

      <aside className="sweet-info-stack">
        <div
          className={`sweet-mood-chip sweet-mood-chip--${realm.activeMoodId} ${
            realm.isVoiceListening ? 'is-listening' : ''
          }`}
          aria-live="polite"
        >
          <span>Lily Mode</span>
          <strong>{realm.activeMood.label}</strong>
          <em>{realm.voiceTranscript || `${realm.voiceStatus.detail} - ${realm.activeLanguage.title}`}</em>
        </div>
        <div className="sweet-language-switch" role="group" aria-label="Reply language">
          {realm.languages.map((language) => (
            <button
              key={language.id}
              type="button"
              className={language.id === realm.activeLanguageId ? 'is-active' : ''}
              aria-pressed={language.id === realm.activeLanguageId}
              onClick={() => realm.selectLanguage(language.id)}
            >
              <strong>{language.label}</strong>
              <span>{language.title}</span>
            </button>
          ))}
        </div>
        <div className="sweet-voice-picker" aria-label="Affectionate address">
          <header>
            <strong>How Lily Calls You</strong>
            <span>{realm.activeAddressTerm.label}</span>
          </header>
          <div className="sweet-voice-picker-options" role="group" aria-label="Affectionate address">
            {realm.addressTermOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                className={option.id === realm.addressTermId ? 'is-active' : ''}
                aria-pressed={option.id === realm.addressTermId}
                title={option.detail}
                onClick={() => realm.selectAddressTerm(option.id)}
              >
                <strong>{option.label}</strong>
                <span>{option.romaji || option.detail}</span>
              </button>
            ))}
          </div>
        </div>
        {realm.isEnglishVoicePickerVisible && (
          <div className="sweet-voice-picker" aria-label="English voice picker">
            <header>
              <strong>English Voice</strong>
              <span>{realm.activeEnglishVoiceOption.title}</span>
            </header>
            <div className="sweet-voice-picker-options" role="group" aria-label="English voice profile">
              {realm.englishVoiceOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={option.id === realm.englishVoiceProfile ? 'is-active' : ''}
                  aria-pressed={option.id === realm.englishVoiceProfile}
                  onClick={() => realm.selectEnglishVoiceProfile(option.id)}
                >
                  <strong>{option.label}</strong>
                  <span>{option.title}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="sweet-voice-picker" aria-label="Voice engine route">
          <header>
            <strong>Voice Engine</strong>
            <span>{realm.activeVoiceRoute.label}</span>
          </header>
          <div className="sweet-voice-picker-options" role="group" aria-label="Voice engine route">
            {realm.voiceRouteOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                className={option.id === realm.voiceRoute ? 'is-active' : ''}
                aria-pressed={option.id === realm.voiceRoute}
                title={option.title}
                onClick={() => realm.selectVoiceRoute(option.id)}
              >
                <strong>{option.label}</strong>
                <span>{option.id === 'alibaba' ? 'Qwen clone' : option.title}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="sweet-presence-picker" aria-label="Owner presence">
          <header>
            <strong>Presence</strong>
            <span>{realm.ownerPresence.label || 'Available'}</span>
          </header>
          <p>{realm.ownerPresence.note || 'Manual activity hint for Lily.'}</p>
          <div className="sweet-presence-options" role="group" aria-label="Owner presence status">
            {realm.presenceOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                className={realm.ownerPresence.status === option.id ? 'is-active' : ''}
                aria-pressed={realm.ownerPresence.status === option.id}
                disabled={realm.isPresenceUpdating}
                onClick={() => realm.selectOwnerPresence(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="sweet-status-strip" aria-label="Lily system status">
          <span className={`sweet-status-pill is-${realm.healthSummary.coreTone}`}>
            Core <strong>{realm.healthSummary.coreLabel}</strong>
          </span>
          <span className={`sweet-status-pill is-${realm.healthSummary.brainTone}`}>
            Brain <strong>{realm.healthSummary.brainLabel}</strong>
          </span>
          <span className={`sweet-status-pill is-${realm.healthSummary.voiceTone}`}>
            Voice <strong>{realm.healthSummary.voiceLabel}</strong>
          </span>
        </div>
        {isCoreOffline && (
          <section className="sweet-offline-card" role="status" aria-live="polite">
            <span>Core Link Offline</span>
            <strong>Local room standby</strong>
            <p>Chat stays visible here while Lily waits for the core route to return.</p>
          </section>
        )}
        <section className="sweet-info-card">
          <header>
            <h3>Character Info</h3>
            <span>fav</span>
          </header>
          <dl>
            <div>
              <dt>Name</dt>
              <dd>Lily</dd>
            </div>
            <div>
              <dt>Personality</dt>
              <dd>Warm, playful, concise</dd>
            </div>
            <div>
              <dt>Language</dt>
              <dd>{realm.activeLanguage.title}</dd>
            </div>
            <div>
              <dt>Voice</dt>
              <dd>{realm.activeLanguage.voiceProfile}</dd>
            </div>
          </dl>
        </section>
        <section className="sweet-info-card sweet-tip-card">
          <h3>Tips</h3>
          <p>{realm.healthSummary.detail}</p>
        </section>
        <section className="sweet-info-card sweet-toggle-card">
          <div>
            <h3>Focus Mode</h3>
            <p>Bubble & chat can stay gentle while you work.</p>
          </div>
          <span className="sweet-toggle" />
        </section>
      </aside>
    </main>
  )
}
