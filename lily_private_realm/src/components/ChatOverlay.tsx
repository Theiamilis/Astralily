import { useEffect, useRef } from 'react'
import ChatBubble from './ChatBubble'

export interface ChatMessage {
  sender: 'user' | 'lily'
  text: string
}

interface ChatOverlayProps {
  messages: ChatMessage[]
  input: string
  isSending: boolean
  visible: boolean
  onInputChange: (value: string) => void
  onSend: () => void
  onClose: () => void
}

export default function ChatOverlay({
  messages,
  input,
  isSending,
  visible,
  onInputChange,
  onSend,
  onClose,
}: ChatOverlayProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  useEffect(() => {
    if (visible) {
      setTimeout(() => inputRef.current?.focus(), 300)
    }
  }, [visible])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSend()
    }
  }

  // Only show last few messages to keep it compact
  const recentMessages = messages.slice(-6)

  return (
    <div className={`chat-float ${visible ? 'chat-float--visible' : ''}`}>
      {/* Close button */}
      <button className="chat-float__close" onClick={onClose} aria-label="Close chat">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      {/* Messages */}
      <div className="chat-float__messages" ref={scrollRef}>
        {recentMessages.length === 0 && !isSending && (
          <div className="chat-float__empty">Say hi to Lily~</div>
        )}
        {recentMessages.map((msg, i) => (
          <ChatBubble key={i} sender={msg.sender} text={msg.text} />
        ))}
        {isSending && <ChatBubble sender="lily" text="" isTyping />}
      </div>

      {/* Input */}
      <div className="chat-float__input-row">
        <input
          ref={inputRef}
          type="text"
          className="chat-float__input"
          placeholder="Say something..."
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isSending}
        />
        <button
          className="chat-float__send"
          onClick={onSend}
          disabled={isSending || !input.trim()}
          aria-label="Send message"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>
    </div>
  )
}
