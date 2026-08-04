/**
 * Synchronized-output wrapper (CSI ?2026, "sync updates").
 *
 * Every frame Ink writes gets bracketed in begin/end synchronized-output so
 * the terminal composites it atomically instead of painting mid-erase state —
 * the primary source of visible flicker during streaming. This is exactly
 * what pi's main-screen renderer does per paint batch; alt-screen is NOT
 * required for it.
 *
 * Terminals that don't implement mode 2026 ignore unknown DEC private modes,
 * so emitting unconditionally is safe; BUBBLE_NO_SYNC_OUTPUT=1 is the escape
 * hatch for anything that misbehaves. Only string chunks are bracketed —
 * Ink writes frames as strings; binary writes pass through untouched.
 */

export const BEGIN_SYNC = "\x1b[?2026h";
export const END_SYNC = "\x1b[?2026l";

export function wrapSynchronizedOutput(stream: NodeJS.WriteStream): NodeJS.WriteStream {
  if (!stream.isTTY || process.env.BUBBLE_NO_SYNC_OUTPUT === "1") return stream;
  return new Proxy(stream, {
    get(target, prop) {
      if (prop === "write") {
        return (chunk: unknown, ...rest: unknown[]) =>
          typeof chunk === "string" && chunk.length > 0
            ? target.write(BEGIN_SYNC + chunk + END_SYNC, ...(rest as [never]))
            : target.write(chunk as never, ...(rest as [never]));
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, prop, value) {
      Reflect.set(target, prop, value);
      return true;
    },
  }) as NodeJS.WriteStream;
}
