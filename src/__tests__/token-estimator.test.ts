import { describe, expect, it } from "vitest";
import {
  HeuristicEstimator,
  TiktokenEstimator,
  getTokenEstimator,
} from "../context/token-estimator.js";

describe("HeuristicEstimator", () => {
  const heuristic = new HeuristicEstimator();

  it("returns 0 for empty input", () => {
    expect(heuristic.estimate("")).toBe(0);
  });

  it("approximates ASCII at ~chars/4", () => {
    // 16 chars → ceil(16/4) = 4
    expect(heuristic.estimate("hello world abcd")).toBe(4);
  });

  it("weights CJK ideographs ~1 token per character", () => {
    // 4 CJK chars → at least 4 tokens (much more than 4/4 = 1)
    expect(heuristic.estimate("你好世界")).toBeGreaterThanOrEqual(4);
  });

  it("mixes ASCII and CJK additively", () => {
    // 8 ASCII / 4 = 2, + 4 CJK = 6 → ceil = 6
    expect(heuristic.estimate("hello!! 你好世界")).toBeGreaterThanOrEqual(6);
  });
});

describe("TiktokenEstimator", () => {
  const tiktoken = new TiktokenEstimator();

  it("uses real BPE for normal English (fewer tokens than chars/4 for short words)", () => {
    // "Hello world" is 2 tokens with o200k_base, well under heuristic's 3.
    expect(tiktoken.estimate("Hello world")).toBe(2);
  });

  it("falls back to heuristic on inputs longer than the tiktoken cap", () => {
    const huge = "a".repeat(100_000);
    // Heuristic returns ceil(100000/4) = 25000; tiktoken would hang on this.
    expect(tiktoken.estimate(huge)).toBe(25_000);
  });

  it("falls back to heuristic on long repeated-character runs", () => {
    // 1000 'x's would pathologize tiktoken's regex. Heuristic returns 250.
    expect(tiktoken.estimate("x".repeat(1_000))).toBe(250);
  });
});

describe("getTokenEstimator", () => {
  it("routes openai and openai-codex to tiktoken", () => {
    expect(getTokenEstimator("openai")).toBeInstanceOf(TiktokenEstimator);
    expect(getTokenEstimator("openai-codex")).toBeInstanceOf(TiktokenEstimator);
  });

  it("routes other providers to the heuristic", () => {
    expect(getTokenEstimator("deepseek")).toBeInstanceOf(HeuristicEstimator);
    expect(getTokenEstimator("zai")).toBeInstanceOf(HeuristicEstimator);
    expect(getTokenEstimator(undefined)).toBeInstanceOf(HeuristicEstimator);
  });
});
