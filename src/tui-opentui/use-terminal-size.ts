import { useTerminalDimensions } from "@opentui/react";

export function useTerminalSize(): { columns: number; rows: number } {
  const { width, height } = useTerminalDimensions();
  return { columns: width || 80, rows: height || 24 };
}
