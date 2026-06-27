import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { useTheme } from "./theme.js";
import type { CompactionProgress } from "../slash-commands/types.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BAR_WIDTH = 24;
// Chars of streamed summary at which the summarizing phase nears its ceiling.
// A 9-section handoff summary is typically ~1.5–4k chars; this makes the bar
// feel alive without ever claiming completion before the model actually returns
// (the curve is asymptotic and capped at 0.9 until the apply phase).
const SUMMARY_CHAR_ESTIMATE = 2500;

const PHASE_LABEL: Record<CompactionProgress["phase"], string> = {
  collecting: "收集历史",
  summarizing: "生成摘要中",
  applying: "应用压缩",
};

/**
 * Map a compaction phase + streamed length onto a 0..1 bar fill. There is no
 * true denominator for a single LLM call, so the curve is honest by design:
 * it ramps but never reaches 1.0 (or even 0.9) until the work is actually done.
 */
export function compactionFraction(progress: CompactionProgress): number {
  switch (progress.phase) {
    case "collecting":
      return 0.05;
    case "summarizing": {
      const ramp = 1 - Math.exp(-progress.streamedChars / SUMMARY_CHAR_ESTIMATE);
      return Math.min(0.9, 0.1 + 0.8 * ramp);
    }
    case "applying":
      return 0.95;
  }
}

export function renderBar(fraction: number, width = BAR_WIDTH): { filled: string; empty: string } {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filledCount = Math.round(clamped * width);
  return {
    filled: "█".repeat(filledCount),
    empty: "░".repeat(width - filledCount),
  };
}

function formatChars(count: number): string {
  if (count < 1000) return `${count}`;
  return `${(count / 1000).toFixed(1)}k`;
}

/**
 * Bottom-stack progress card for a manual `/compact` run. Mount it only while a
 * compaction is in flight (i.e. render conditionally on a non-null progress) so
 * its elapsed-time clock resets per run.
 */
export function CompactionProgressCard({ progress }: { progress: CompactionProgress | null }) {
  const theme = useTheme();
  const [frameIndex, setFrameIndex] = useState(0);
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => {
      setFrameIndex((i) => (i + 1) % SPINNER_FRAMES.length);
      setNow(Date.now());
    }, 100);
    return () => clearInterval(t);
  }, []);

  if (!progress) return null;

  const fraction = compactionFraction(progress);
  const { filled, empty } = renderBar(fraction);
  const pct = Math.round(fraction * 100);
  const elapsed = ((now - startedAt) / 1000).toFixed(1);
  const phaseLine =
    progress.phase === "summarizing"
      ? `· ${PHASE_LABEL.summarizing} (流式接收 ${formatChars(progress.streamedChars)} chars)`
      : `· ${PHASE_LABEL[progress.phase]}`;

  return (
    <Box flexDirection="column" paddingX={1} paddingBottom={1} flexShrink={0}>
      <Text color={theme.accent}>{`${SPINNER_FRAMES[frameIndex]} Compacting context…`}</Text>
      <Text>
        <Text color={theme.muted}>[</Text>
        <Text color={theme.accent}>{filled}</Text>
        <Text color={theme.dim}>{empty}</Text>
        <Text color={theme.muted}>{`] ${pct}%`}</Text>
      </Text>
      <Text color={theme.muted}>{phaseLine}</Text>
      <Text color={theme.muted}>{`· 已耗时 ${elapsed}s`}</Text>
    </Box>
  );
}
