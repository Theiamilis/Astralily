interface StatusChipProps {
  label: string;
  status: 'ready' | 'limited' | 'offline' | 'unknown';
}

export function StatusChip({ label, status }: StatusChipProps) {
  const colors = {
    ready: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    limited: 'bg-amber-100 text-amber-700 border-amber-200',
    offline: 'bg-rose-100 text-rose-700 border-rose-200',
    unknown: 'bg-gray-100 text-gray-600 border-gray-200'
  };

  return (
    <div className={`px-3 py-1.5 rounded-full border ${colors[status]} text-sm font-medium`}>
      {label}
    </div>
  );
}
