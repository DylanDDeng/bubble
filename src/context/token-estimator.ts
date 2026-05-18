// Token estimation strategy layer.
//
// Different providers use different tokenizers; a single "chars/4" rule under-counts
// dense content (HTML, CJK) and lets auto-compact fire too late. This module routes
// per-provider: OpenAI / OpenAI-Codex uses js-tiktoken with the o200k_base BPE; every
// other provider uses a CJK-aware heuristic. Drop in a new strategy per provider as
// their tokenizers become important without touching call sites.

import type { Tiktoken } from "js-tiktoken/lite";

export interface TokenEstimator {
  estimate(text: string): number;
}

// Tiktoken's pre-tokenization regex is catastrophic on inputs with long single-char
// runs ("x".repeat(4000) → 1.4s; bigger → minutes/hang). Two guards: a hard length
// cap, and a cheap scan for any run ≥ MAX_RUN_LEN of the same code unit. Both catch
// production hazards (binary blobs, base64 dumps, leaked buffers) and synthetic test
// fixtures alike. Normal prose / code / markdown stays well under both.
const TIKTOKEN_MAX_CHARS = 80_000;
const MAX_RUN_LEN = 64;

function hasPathologicalRun(text: string): boolean {
  if (text.length < MAX_RUN_LEN) return false;
  let last = text.charCodeAt(0);
  let run = 1;
  for (let i = 1; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === last) {
      run++;
      if (run >= MAX_RUN_LEN) return true;
    } else {
      last = code;
      run = 1;
    }
  }
  return false;
}

// Cheap codepoint check: CJK ideographs + Hiragana/Katakana + Hangul.
// Each such char is roughly 1 token (vs ~0.25 token for ASCII), so weighting them
// 1.0 cuts the heuristic's CJK undercount by ~4x without needing a real tokenizer.
function isCjkCodePoint(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x9fff) ||   // CJK symbols + unified ideographs (incl. Hiragana/Katakana)
    (code >= 0xac00 && code <= 0xd7af) ||   // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) ||   // CJK compatibility ideographs
    (code >= 0x20000 && code <= 0x2ffff)    // CJK extensions B–F (surrogate pairs)
  );
}

export class HeuristicEstimator implements TokenEstimator {
  estimate(text: string): number {
    if (!text) return 0;
    let cjk = 0;
    let other = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.codePointAt(i)!;
      if (code > 0xffff) i++; // skip surrogate low half
      if (isCjkCodePoint(code)) cjk++;
      else other++;
    }
    return Math.ceil(cjk + other / 4);
  }
}

export class TiktokenEstimator implements TokenEstimator {
  private encoder: Tiktoken | null = null;
  private initFailed = false;
  private readonly fallback = new HeuristicEstimator();

  estimate(text: string): number {
    if (!text) return 0;
    if (text.length > TIKTOKEN_MAX_CHARS) return this.fallback.estimate(text);
    if (hasPathologicalRun(text)) return this.fallback.estimate(text);
    const enc = this.getEncoder();
    if (!enc) return this.fallback.estimate(text);
    try {
      return enc.encode(text).length;
    } catch {
      return this.fallback.estimate(text);
    }
  }

  private getEncoder(): Tiktoken | null {
    if (this.encoder) return this.encoder;
    if (this.initFailed) return null;
    try {
      // Lazy require: defers ~1MB of BPE table load until OpenAI is actually used.
      const tiktoken = require("js-tiktoken") as typeof import("js-tiktoken");
      this.encoder = tiktoken.getEncoding("o200k_base");
      return this.encoder;
    } catch {
      this.initFailed = true;
      return null;
    }
  }
}

const HEURISTIC = new HeuristicEstimator();
const TIKTOKEN = new TiktokenEstimator();

export function getTokenEstimator(providerId?: string): TokenEstimator {
  if (providerId === "openai" || providerId === "openai-codex") return TIKTOKEN;
  return HEURISTIC;
}
