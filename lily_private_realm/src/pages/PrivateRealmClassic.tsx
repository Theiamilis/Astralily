import { useState } from 'react'
import Live2DPanel from '../components/Live2DPanel'
import {
  statusLabel,
  usePrivateRealm,
} from '../realm/usePrivateRealm'
import type { ChatMessage } from '../realm/usePrivateRealm'
import './PrivateRealmClassic.css'

function StatusPill({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: string
  tone?: 'good' | 'warn' | 'bad' | 'neutral'
}) {
  return (
    <div className={`realm-pill realm-pill--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function MessageBubble({ message }: { message: ChatMessage }) {
  return (
    <article className={`realm-message realm-message--${message.sender}`}>
      <span className="realm-message__name">
        {message.sender === 'lily' ? 'Lily' : 'You'}
      </span>
      <p>{message.text}</p>
    </article>
  )
}

export default function PrivateRealmClassic() {
  const realm = usePrivateRealm()
  const [isExpressionDebugVisible, setIsExpressionDebugVisible] = useState(false)

  return (
    <main className="realm-shell">
      <audio ref={realm.audioRef} hidden />

      <section className="realm-card realm-avatar-card">
        <div className="realm-card__header">
          <div>
            <span className="realm-kicker">Lily Console</span>
            <h1>Lily</h1>
          </div>
          <span className="realm-mode-badge">Owner Mode</span>
        </div>

        <div className="realm-stage">
          <div className="realm-stage__chrome" aria-hidden="true">
            <span>Portrait Capture</span>
            <i />
          </div>
          <Live2DPanel
            expression={realm.latestExpression}
            expressionKey={realm.latestExpressionKey}
            idleExpression={realm.moodExpression}
            lipSyncLevel={realm.lipSyncLevel}
            onExpressionResolved={realm.setExpressionResolution}
          />
          <div className="realm-stage__veil" />
          {realm.latestLilyLine && (
            <div className="realm-stage__caption" aria-live="polite">
              <span>Lily Overlay</span>
              <p>{realm.latestLilyLine}</p>
            </div>
          )}
          <button
            type="button"
            className="realm-expression-debug-toggle"
            aria-pressed={isExpressionDebugVisible}
            onClick={() => setIsExpressionDebugVisible((current) => !current)}
          >
            Debug
          </button>
          {isExpressionDebugVisible && (
            <div className="realm-expression-debug" aria-label="Expression debug">
              <span>Emotion <strong>{realm.latestEmotion || 'neutral'}</strong></span>
              <span>Requested <strong>{realm.expressionResolution?.requested || realm.latestExpression || 'Blush'}</strong></span>
              <span>Resolved <strong>{realm.expressionResolution?.resolved || 'Blush'}</strong></span>
              <span>Source <strong>{realm.latestExpressionSource || 'standby'}</strong></span>
              <span>Resolver <strong>{realm.expressionResolution?.source || 'standby'}</strong></span>
            </div>
          )}
        </div>

        <div className="realm-mood-grid">
          <div>
            <span>Mood</span>
            <strong>Soft Focus</strong>
          </div>
          <div>
            <span>Presence</span>
            <strong>Listening</strong>
          </div>
        </div>
      </section>

      <section className="realm-main">
        <header className="realm-topbar">
          <div>
            <span className="realm-kicker">Private Realm</span>
            <h2>Desktop companion room</h2>
          </div>
          <div className="realm-topbar__status">
            <StatusPill label="Core" value={statusLabel(realm.health?.status)} tone={realm.coreTone} />
            <StatusPill label="Brain" value={statusLabel(realm.components.brain?.status)} tone={realm.brainTone} />
            <StatusPill label="Voice" value={statusLabel(realm.components.voice?.status)} tone={realm.voiceTone} />
            <span className="realm-sync">last sync {realm.lastSync}</span>
          </div>
        </header>

        <div className="realm-workspace">
          <section className="realm-chat realm-card">
            <div className="realm-card__header realm-chat__header">
              <div>
                <span className="realm-kicker">Owner Chat</span>
                <h2>Talk with Lily</h2>
              </div>
              <select
                value={realm.chatMode}
                onChange={(event) => realm.setChatMode(event.target.value)}
                aria-label="Chat mode"
              >
                <option>Private Realm</option>
                <option>Coding Companion</option>
                <option>Gaming Companion</option>
                <option>Text Only</option>
              </select>
            </div>

            <div className="realm-chat__messages">
              {realm.messages.length === 0 && (
                <div className="realm-empty">
                  <span>Quiet room ready.</span>
                  <p>Start chatting whenever you want. Lily will use the core route when available.</p>
                </div>
              )}
              {realm.messages.map((message, index) => (
                <MessageBubble key={`${message.sender}-${index}`} message={message} />
              ))}
              {realm.isSending && (
                <article className="realm-message realm-message--lily">
                  <span className="realm-message__name">Lily</span>
                  <p className="realm-typing">thinking softly...</p>
                </article>
              )}
              <div ref={realm.chatEndRef} />
            </div>

            <div className="realm-chat__composer">
              <input
                value={realm.input}
                onChange={(event) => realm.setInput(event.target.value)}
                onKeyDown={realm.handleKeyDown}
                placeholder="Message Lily from this dashboard..."
                disabled={realm.isSending}
              />
              <button onClick={() => void realm.sendMessage()} disabled={!realm.input.trim() || realm.isSending}>
                Send
              </button>
            </div>
          </section>

          <aside className="realm-side">
            <section className="realm-card realm-note-card">
              <span className="realm-kicker">Current State</span>
              <h3>{realm.chatMode}</h3>
              <p>
                Lily keeps this space calm: chat first, voice when the core and
                SoVITS path are both ready.
              </p>
            </section>

            <section className="realm-card realm-language-card">
              <span className="realm-kicker">Reply Language</span>
              <div className="realm-choice-grid" role="group" aria-label="Reply language">
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

              {realm.isEnglishVoicePickerVisible ? (
                <div className="realm-choice-block">
                  <span className="realm-kicker">English Voice</span>
                  <div className="realm-choice-grid" role="group" aria-label="English voice profile">
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
              ) : (
                <p className="realm-language-card__hint">
                  Switch to English to compare Zeta and Watson.
                </p>
              )}

              <div className="realm-choice-block">
                <span className="realm-kicker">How Lily Calls You</span>
                <div className="realm-choice-grid" role="group" aria-label="Affectionate address">
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
                <p className="realm-language-card__hint">
                  Japanese TTS uses ダーリン (*dārin*), not the Latin spelling “daalin”.
                </p>
              </div>

              <div className="realm-choice-block">
                <span className="realm-kicker">Voice Engine</span>
                <div className="realm-choice-grid" role="group" aria-label="Voice engine route">
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
                <p className="realm-language-card__hint">
                  Active: {realm.activeVoiceRoute.title}. Alibaba uses the clone IDs configured in Core.
                </p>
              </div>
            </section>

            <section className="realm-card realm-presence-card">
              <span className="realm-kicker">Owner Presence</span>
              <h3>{realm.ownerPresence.label || 'Available'}</h3>
              <p>{realm.ownerPresence.note || 'Manual activity hint for Lily.'}</p>
              <div className="realm-choice-grid" role="group" aria-label="Owner presence">
                {realm.presenceOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={realm.ownerPresence.status === option.id ? 'is-active' : ''}
                    aria-pressed={realm.ownerPresence.status === option.id}
                    disabled={realm.isPresenceUpdating}
                    onClick={() => realm.selectOwnerPresence(option.id)}
                  >
                    <strong>{option.label}</strong>
                    <span>{option.title}</span>
                  </button>
                ))}
              </div>
            </section>

            <section className="realm-card realm-actions">
              <span className="realm-kicker">Quick Actions</span>
              <button type="button" onClick={realm.stopCurrentVoice}>Stop Voice</button>
              <button type="button">Refresh Core</button>
              <button type="button">Text Only Mode</button>
              <button type="button">Open Control Center</button>
            </section>

            <section className="realm-card realm-memory">
              <span className="realm-kicker">Lily Keeps In Mind</span>
              <div>
                <strong>Owner</strong>
                <p>Lily User</p>
              </div>
              <div>
                <strong>Tone</strong>
                <p>Warm, playful, concise.</p>
              </div>
              <div>
                <strong>Focus</strong>
                <p>PC companion, stream prep, WA routing.</p>
              </div>
            </section>
          </aside>
        </div>
      </section>
    </main>
  )
}
