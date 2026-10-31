import type { ComponentType } from 'react'
import PrivateRealmClassic from '../pages/PrivateRealmClassic'
import PrivateRealmPetMode from '../pages/PrivateRealmPetMode'
import PrivateRealmSweetRoom from '../pages/PrivateRealmSweetRoom'

export type RealmVariantId = 'classic' | 'sweet-room' | 'pet'

export type RealmVariantDefinition = {
  id: RealmVariantId
  label: string
  description: string
  component: ComponentType
}

export const DEFAULT_REALM_VARIANT: RealmVariantId = 'sweet-room'

export const REALM_VARIANTS: Record<RealmVariantId, RealmVariantDefinition> = {
  classic: {
    id: 'classic',
    label: 'Classic Realm',
    description: 'Full desktop companion layout with chat, status, memory, and actions.',
    component: PrivateRealmClassic,
  },
  'sweet-room': {
    id: 'sweet-room',
    label: 'Sweet Room',
    description: 'Pink companion room with chat, center Live2D stage, and character info panels.',
    component: PrivateRealmSweetRoom,
  },
  pet: {
    id: 'pet',
    label: 'Pet Mode',
    description: 'Floating browser companion with draggable Lily, quick chat, and push-to-talk.',
    component: PrivateRealmPetMode,
  },
}

export function resolveRealmVariant(rawVariant?: string | null): RealmVariantDefinition {
  const normalized = (rawVariant || DEFAULT_REALM_VARIANT).trim().toLowerCase()

  if (normalized in REALM_VARIANTS) {
    return REALM_VARIANTS[normalized as RealmVariantId]
  }

  return REALM_VARIANTS[DEFAULT_REALM_VARIANT]
}
