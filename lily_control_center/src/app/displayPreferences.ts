export type ControlCenterVariant = 'classic' | 'sweet-room' | 'overview';
export const DISPLAY_CHANGE_EVENT = 'lily:control-center-display';
const STORAGE_KEY = 'lily_control_center_variant';

export function readDisplayVariant(fallback = 'classic'): ControlCenterVariant {
  const raw = new URLSearchParams(window.location.search).get('variant') || window.localStorage.getItem(STORAGE_KEY) || fallback;
  if (raw === 'overview') return 'overview';
  if (raw === 'sweet' || raw === 'sweet-room') return 'sweet-room';
  return 'classic';
}

export function changeDisplayVariant(variant: ControlCenterVariant) {
  window.localStorage.setItem(STORAGE_KEY, variant);
  const url = new URL(window.location.href);
  url.searchParams.set('variant', variant);
  window.history.replaceState({}, '', url);
  window.dispatchEvent(new CustomEvent(DISPLAY_CHANGE_EVENT));
}
