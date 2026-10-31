import { useEffect, useRef } from 'react'
import ChatBubble from './ChatBubble'
import type { ChatMessage } from './ChatOverlay'

interface ChatPanelProps {
  messages: ChatMessage[]
  input: string
  isSending: boolean
  onInputChange: (value: string) => void
  onSend: () => void
}

export default function ChatPanel({
  messages,
  input,
  isSending,
  onInputChange,
  onSend,
}: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSend()
    }
  }

  return (
    <div className="chat-panel">
      {/* Header */}
      <div className="chat-panel__header">
        <span className="chat-panel__label">PRIVATE REALM</span>
        <h2 className="chat-panel__title">Lily</h2>
        <div className="chat-panel__status">
          <span className="chat-panel__status-dot" />
          <span className="chat-panel__status-text">Online</span>
        </div>
      </div>

      {/* Messages */}
      <div className="chat-panel__messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat-panel__empty">
            <p className="chat-panel__empty-title">No messages yet</p>
            <p className="chat-panel__empty-sub">Start a conversation with Lily</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <ChatBubble key={i} sender={msg.sender} text={msg.text} />
        ))}
        {isSending && <ChatBubble sender="lily" text="" isTyping />}
      </div>

      {/* Input */}
      <div className="chat-panel__input-bar">
        <input
          ref={inputRef}
          type="text"
          className="chat-panel__input"
          placeholder="Say something to Lily..."
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isSending}
        />
        <button
          className="chat-panel__send"
          onClick={onSend}
          disabled={isSending || !input.trim()}
          aria-label="Send message"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>
    </div>
  )
}
