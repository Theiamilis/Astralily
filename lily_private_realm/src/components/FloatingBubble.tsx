import { useEffect, useState } from 'react'

interface FloatingBubbleProps {
  text: string
  visible: boolean
  onTap: () => void
}

export default function FloatingBubble({ text, visible, onTap }: FloatingBubbleProps) {
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (visible && text) {
      setShow(true)
    } else {
      setShow(false)
    }
  }, [visible, text])

  if (!show || !text) return null

  return (
    <div className="floating-bubble" onClick={onTap}>
      <div className="floating-bubble__inner">
        <span className="floating-bubble__name">Lily</span>
        <p className="floating-bubble__text">{text}</p>
        <span className="floating-bubble__hint">Tap to chat</span>
      </div>
    </div>
  )
}
