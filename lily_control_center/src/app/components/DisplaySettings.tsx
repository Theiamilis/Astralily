import { useState } from 'react';
import { changeDisplayVariant, readDisplayVariant, type ControlCenterVariant } from '../displayPreferences';

export function DisplaySettings() {
  const [variant, setVariant] = useState(() => readDisplayVariant(import.meta.env.VITE_CONTROL_CENTER_VARIANT));
  const modes: { id: ControlCenterVariant; name: string; description: string }[] = [
    { id: 'overview', name: 'Overview', description: 'Family map, lights, computers and Lily. Live2D is optional.' },
    { id: 'classic', name: 'Classic', description: 'The original full Control Center dashboard.' },
    { id: 'sweet-room', name: 'Sweet Room', description: 'The companion room layout.' },
  ];
  return <fieldset className="grid gap-3"><legend className="mb-4 text-lg font-semibold text-[#392130]">Control Center appearance</legend>{modes.map((mode) => <label key={mode.id} className="flex min-h-20 cursor-pointer items-start gap-3 rounded-2xl border border-[#dfc0d2] bg-white p-4"><input type="radio" name="control-center-variant" value={mode.id} checked={variant === mode.id} onChange={() => { setVariant(mode.id); changeDisplayVariant(mode.id); }} className="mt-1 h-5 w-5 accent-[#b8437c]" /><span><strong className="text-sm text-[#392130]">{mode.name}</strong><span className="mt-1 block text-xs leading-5 text-[#76586a]">{mode.description}</span></span></label>)}<p className="text-xs leading-6 text-[#76586a]">Saved in this browser. In Overview, use Lily’s Live2D switch to choose the character or audio waveform.</p></fieldset>;
}
