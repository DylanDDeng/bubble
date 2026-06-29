import { useEffect, useState } from "react";
import { useStdout } from "ink";

/**
 * Shared resize subscription: every useTerminalSize consumer (one per markdown
 * block, the app shell, etc.) used to attach its own `resize` listener to
 * stdout, so a transcript with many size-aware blocks tripped Node/Bun's
 * default 10-listener cap (MaxListenersExceededWarning). They now share a single
 * listener via this module-level registry, so the stdout listener count stays
 * at one regardless of how many components subscribe.
 */
type ResizeStream = { on: Function; off?: Function; removeListener?: Function };

const subscribers = new Set<() => void>();
let attachedStream: ResizeStream | null = null;

function notifyAll(): void {
  for (const cb of subscribers) cb();
}

function detach(): void {
  if (!attachedStream) return;
  const off = attachedStream.off ?? attachedStream.removeListener;
  off?.call(attachedStream, "resize", notifyAll);
  attachedStream = null;
}

function subscribe(stream: ResizeStream, cb: () => void): () => void {
  subscribers.add(cb);
  if (attachedStream !== stream) {
    detach();
    stream.on("resize", notifyAll);
    attachedStream = stream;
  }
  return () => {
    subscribers.delete(cb);
    if (subscribers.size === 0) detach();
  };
}

export function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => ({
    columns: stdout?.columns || 80,
    rows: stdout?.rows || 24,
  }));

  useEffect(() => {
    if (!stdout) return;
    const update = () => {
      setSize((prev) => {
        const next = { columns: stdout.columns || 80, rows: stdout.rows || 24 };
        return prev.columns === next.columns && prev.rows === next.rows ? prev : next;
      });
    };
    update(); // sync in case the size changed between initial state and mount
    return subscribe(stdout as unknown as ResizeStream, update);
  }, [stdout]);

  return size;
}
