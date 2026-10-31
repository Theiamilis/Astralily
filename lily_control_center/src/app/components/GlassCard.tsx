import { ReactNode } from 'react';

interface GlassCardProps {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export function GlassCard({ children, className = '', style }: GlassCardProps) {
  return (
    <div
      className={`backdrop-blur-md bg-white/60 rounded-3xl border border-white/40 shadow-lg ${className}`}
      style={style}
    >
      {children}
    </div>
  );
}
