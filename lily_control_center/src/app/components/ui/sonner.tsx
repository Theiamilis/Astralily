"use client";

import { useTheme } from "next-themes";
import { ToLily-Voice-Host as Sonner, ToLily-Voice-HostProps } from "sonner";

const ToLily-Voice-Host = ({ ...props }: ToLily-Voice-HostProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToLily-Voice-HostProps["theme"]}
      className="toLily-Voice-Host group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { ToLily-Voice-Host };
