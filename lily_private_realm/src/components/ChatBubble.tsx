interface ChatBubbleProps {
  sender: 'user' | 'lily'
  text: string
  isTyping?: boolean
}

export default function ChatBubble({ sender, text, isTyping }: ChatBubbleProps) {
  return (
    <div className={`chat-bubble chat-bubble--${sender}`}>
      {sender === 'lily' && (
        <span className="chat-bubble__name">Lily</span>
      )}
      <div className="chat-bubble__content">
        {isTyping ? (
          <span className="chat-bubble__typing">
            <span className="chat-bubble__dot" />
            <span className="chat-bubble__dot" />
            <span className="chat-bubble__dot" />
          </span>
        ) : (
          <p className="chat-bubble__text">{text}</p>
        )}
      </div>
    </div>
  )
}
