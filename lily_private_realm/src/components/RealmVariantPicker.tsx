import { useState } from 'react'
import { REALM_VARIANTS, type RealmVariantId } from '../realm/variantRegistry'
import './RealmVariantPicker.css'

type RealmVariantPickerProps = {
  activeVariant: RealmVariantId
}

export default function RealmVariantPicker({ activeVariant }: RealmVariantPickerProps) {
  const [isOpen, setIsOpen] = useState(false)
  const activeLabel = REALM_VARIANTS[activeVariant].label

  function switchVariant(nextVariant: RealmVariantId) {
    const url = new URL(window.location.href)
    url.searchParams.set('variant', nextVariant)
    url.searchParams.delete('variantPicker')
    window.location.href = url.toString()
  }

  return (
    <aside
      className={`realm-variant-picker realm-variant-picker--${activeVariant} ${isOpen ? 'is-open' : ''}`}
      aria-label="Realm variant picker"
    >
      <button
        type="button"
        className="realm-variant-toggle"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
      >
        <span>UI</span>
        {activeLabel}
      </button>
      <div className="realm-variant-options">
        {Object.values(REALM_VARIANTS).map((variant) => (
          <button
            key={variant.id}
            type="button"
            className={variant.id === activeVariant ? 'is-active' : ''}
            onClick={() => switchVariant(variant.id)}
            title={variant.description}
          >
            {variant.label}
          </button>
        ))}
      </div>
    </aside>
  )
}
