import stringWidth from "string-width";

/**
 * One verdict for the whole TUI: does THIS terminal render East Asian
 * *Ambiguous*-width characters as 2 cells?
 *
 * Ambiguous-width (Unicode EastAsianWidth=A) covers the curly quotes “ ”, the
 * em dash —, the ● bullet, the ellipsis …, box-drawing ─│┼ and more. `string-
 * width`'s default counts them as 1, but a terminal can render them as 2 — and
 * crucially that choice is a property of the *terminal + font*, NOT the locale:
 * this project's own author hits wide rendering under `LANG=en_US`. When our
 * width math disagrees with the terminal, a line we packed to "exactly fits"
 * overflows and the terminal applies its own hard wrap, dropping the overflow
 * tail onto a stray physical row (the lone "顺" + vertical-gap corruption).
 *
 * So the verdict is resolved, in priority order:
 *   1. explicit env override `BUBBLE_AMBIGUOUS_WIDTH=wide|narrow`,
 *   2. a one-shot CSI 6n cursor probe of the real terminal at startup,
 *   3. a CJK-locale guess as the last resort.
 *
 * EVERYTHING that measures display width for wrapping, cursor mapping, padding,
 * truncation or gutter budgeting must go through `visualWidth`/`graphemeWidth`
 * here, so the entire UI shares the single verdict and stays self-consistent.
 */

let ambiguousWide = initialGuess();

function envOverride(): boolean | undefined {
  const v = process.env.BUBBLE_AMBIGUOUS_WIDTH?.trim().toLowerCase();
  if (!v) return undefined;
  if (/^(wide|double|full|2)$/.test(v)) return true;
  if (/^(narrow|single|half|1)$/.test(v)) return false;
  return undefined;
}

function localeIsCJK(): boolean {
  const lang = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "";
  return /(^|[._-])(zh|ja|ko)/i.test(lang);
}

function initialGuess(): boolean {
  const override = envOverride();
  return override !== undefined ? override : localeIsCJK();
}

/** Current verdict — true when ambiguous-width chars occupy 2 terminal cells. */
export function ambiguousIsWide(): boolean {
  return ambiguousWide;
}

/** Deterministic override for tests (force CJK-wide / narrow). */
export function setAmbiguousWide(v: boolean): void {
  ambiguousWide = v;
}

export function visualWidth(str: string): number {
  if (!str) return 0;
  return stringWidth(str, { ambiguousIsNarrow: !ambiguousWide });
}

export function graphemeWidth(grapheme: string): number {
  if (!grapheme) return 0;
  return stringWidth(grapheme, { ambiguousIsNarrow: !ambiguousWide });
}

/**
 * Probe the real terminal once at startup, before Ink owns the TTY: print a
 * single ambiguous-width glyph at column 1, ask where the cursor landed via the
 * DSR cursor-position report (`CSI 6n` → `ESC [ row ; col R`), and read back the
 * glyph's rendered width. Width 2 → ambiguous-wide; width 1 → narrow.
 *
 * An explicit env override wins and skips the probe entirely. A non-TTY (pipe,
 * CI) or an unresponsive terminal (the `setTimeout` fires) leaves the locale
 * guess untouched. The probe glyph is erased before returning so the first Ink
 * paint sees a clean line.
 */
export async function detectAmbiguousWidth(timeoutMs = 150): Promise<void> {
  if (envOverride() !== undefined) return; // explicit choice already applied
  const { stdin, stdout } = process;
  if (!stdout.isTTY || !stdin.isTTY || typeof stdin.setRawMode !== "function") return;

  const wasRaw = stdin.isRaw ?? false;
  const wasFlowing = stdin.readableFlowing ?? false;

  const measured = await new Promise<number | null>((resolve) => {
    let buf = "";
    let settled = false;
    const finish = (result: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.removeListener("data", onData);
      try {
        stdin.setRawMode(wasRaw);
      } catch {
        // teardown best-effort
      }
      if (!wasFlowing) stdin.pause();
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      const m = /\x1b\[\d+;(\d+)R/.exec(buf);
      if (m) finish(Number(m[1]) - 1); // col is 1-based; col-1 = glyph width
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
      // \r → column 1, print the probe glyph (U+201C “), then request the cursor
      // column. The reported column minus 1 is the glyph's rendered cell width.
      stdout.write("\r“\x1b[6n");
    } catch {
      finish(null);
    }
  });

  if (measured === 2) ambiguousWide = true;
  else if (measured === 1) ambiguousWide = false;
  // measured === null → probe failed; keep the locale-based guess.

  try {
    if (stdout.isTTY) stdout.write("\r\x1b[K"); // wipe the probe glyph
  } catch {
    // stdout best-effort
  }
}
