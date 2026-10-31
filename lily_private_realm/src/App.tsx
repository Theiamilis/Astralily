import RealmVariantPicker from './components/RealmVariantPicker'
import { resolveRealmVariant } from './realm/variantRegistry'

function getVariantSource() {
  const queryVariant = new URLSearchParams(window.location.search).get('variant')
  return queryVariant || import.meta.env.VITE_REALM_VARIANT
}

export default function App() {
  const searchParams = new URLSearchParams(window.location.search)
  const variant = resolveRealmVariant(getVariantSource())
  const ActiveRealm = variant.component
  const showVariantPicker = searchParams.get('variantPicker') !== '0'

  return (
    <>
      <ActiveRealm />
      {showVariantPicker && <RealmVariantPicker activeVariant={variant.id} />}
    </>
  )
}
