export type VoiceRouteId = 'sovits' | 'sovits2' | 'rvc' | 'alibaba';
export type AddressTermId = 'sayang' | 'cintaku' | 'beb' | 'love' | 'darling' | 'dear' | 'anata' | 'kimi';

export const VOICE_ROUTE_OPTIONS: Array<{
  id: VoiceRouteId;
  label: string;
  detail: string;
}> = [
  { id: 'sovits', label: 'SoVITS', detail: 'Local GPT-SoVITS' },
  { id: 'sovits2', label: 'SoVITS 2', detail: 'Dedicated second GPT-SoVITS vessel' },
  { id: 'rvc', label: 'RVC', detail: 'Stream voice vessel' },
  { id: 'alibaba', label: 'Alibaba', detail: 'Qwen cloned voice' },
];

export function readVoiceRoutePreference(storageKey = 'lily_control_center_voice_route'): VoiceRouteId {
  const value = window.localStorage.getItem(storageKey);
  return VOICE_ROUTE_OPTIONS.some((option) => option.id === value)
    ? (value as VoiceRouteId)
    : 'sovits';
}

export const ADDRESS_TERM_OPTIONS: Array<{
  id: AddressTermId;
  label: string;
  detail: string;
}> = [
  { id: 'sayang', label: 'Sayang', detail: 'Indonesian, warm' },
  { id: 'cintaku', label: 'Cintaku', detail: 'Indonesian, romantic' },
  { id: 'beb', label: 'Beb', detail: 'Indonesian, casual' },
  { id: 'love', label: 'Love', detail: 'English, warm' },
  { id: 'darling', label: 'Darling / ダーリン', detail: 'English or Japanese romantic address; Japanese TTS reads dārin' },
  { id: 'dear', label: 'Dear', detail: 'English, soft' },
  { id: 'anata', label: 'あなた', detail: 'Japanese, intimate/spouse-like' },
  { id: 'kimi', label: '君', detail: 'Japanese, close and casual' },
];

export function readAddressTermPreference(storageKey = 'lily_control_center_address_term'): AddressTermId {
  const value = window.localStorage.getItem(storageKey);
  return ADDRESS_TERM_OPTIONS.some((option) => option.id === value)
    ? (value as AddressTermId)
    : 'love';
}
