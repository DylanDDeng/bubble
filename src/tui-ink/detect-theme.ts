export type ResolvedTheme = "light" | "dark";

export async function detectTerminalTheme(
  timeoutMs = 150,
): Promise<ResolvedTheme> {
  const fromEnv = parseColorFgBg(process.env.COLORFGBG);
  if (fromEnv) return fromEnv;

  if (process.stdout.isTTY && process.stdin.isTTY) {
    const fromOsc = await queryOsc11(timeoutMs);
    if (fromOsc) return fromOsc;
  }

  return "dark";
}

function parseColorFgBg(value: string | undefined): ResolvedTheme | null {
  if (!value) return null;
  const parts = value.split(";");
  const last = parts[parts.length - 1];
  if (!last) return null;
  const bg = parseInt(last, 10);
  if (Number.isNaN(bg)) return null;
  if (bg >= 0 && bg <= 6) return "dark";
  if (bg >= 7 && bg <= 15) return "light";
  return null;
}

function queryOsc11(timeoutMs: number): Promise<ResolvedTheme | null> {
  return new Promise<ResolvedTheme | null>((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    let settled = false;
    const originalRaw = stdin.isRaw;
    let buffer = "";

    const cleanup = () => {
      stdin.removeListener("data", onData);
      try {
        stdin.setRawMode(originalRaw);
      } catch {
        // ignore - terminal may have already restored
      }
      stdin.pause();
    };

    const finish = (result: ResolvedTheme | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(result);
    };

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const match = buffer.match(
        /\x1b\]11;rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)(?:\x07|\x1b\\)/,
      );
      if (!match) return;
      const [, r, g, b] = match;
      const lum = relativeLuminance(parseHexChannel(r), parseHexChannel(g), parseHexChannel(b));
      finish(lum > 0.5 ? "light" : "dark");
    };

    try {
      stdin.setRawMode(true);
    } catch {
      resolve(null);
      return;
    }
    stdin.resume();
    stdin.on("data", onData);

    const timer = setTimeout(() => finish(null), timeoutMs);

    try {
      stdout.write("\x1b]11;?\x07");
    } catch {
      finish(null);
    }
  });
}

function parseHexChannel(hex: string): number {
  const max = (1 << (hex.length * 4)) - 1;
  return parseInt(hex, 16) / max;
}

function relativeLuminance(r: number, g: number, b: number): number {
  const channel = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
