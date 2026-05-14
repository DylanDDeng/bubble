import { useEffect, useState } from "react";
import { useStdout } from "ink";

export function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => ({
    columns: stdout?.columns || 80,
    rows: stdout?.rows || 24,
  }));

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => {
      // Clear screen + scrollback + home cursor before ink redraws.
      // Without this, the prior render that overflowed terminal height stays as
      // garbled cells in scrollback because ink's log-update can only clear what
      // it last printed within the live region.
      stdout.write("\x1b[2J\x1b[3J\x1b[H");
      setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}
