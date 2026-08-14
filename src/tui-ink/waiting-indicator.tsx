/**
 * The animated spinner row shown while a run is in flight: tool-targeted or
 * generic phrases, streaming token counter, and steer/queue hints.
 */
import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { DisplayToolCall } from "./display-history.js";
import { useTheme } from "./theme.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const GENERIC_PHRASES = [
  "mapping the workspace",
  "reading the room",
  "following the threads",
  "connecting the pieces",
  "sorting the context",
  "scanning the structure",
  "shaping the next step",
  "gathering signal",
  "checking the edges",
  "lining up the answer",
  "tracing the flow",
  "building the picture",
  "walking the graph",
  "collecting the clues",
  "framing the problem",
  "locating the source",
  "resolving the shape",
  "untangling the state",
  "comparing the paths",
  "narrowing the target",
  "tracking the changes",
  "reading the patterns",
  "weighing the options",
  "assembling the context",
  "following the signal",
  "checking the assumptions",
  "aligning the details",
  "testing the shape",
  "pulling the thread",
  "cleaning the edges",
  "refining the draft",
  "verifying the route",
  "making sense of it",
  "looking for leverage",
  "stitching the answer",
  "holding the thread",
  "distilling the noise",
  "finding the seam",
  "reading between the lines",
  "preparing the response",
];

const TOOL_TARGET_PHRASES: Record<string, string> = {
  read: "reading files",
  write: "writing changes",
  edit: "patching files",
  grep: "searching the codebase",
  glob: "scanning paths",
  ls: "listing directories",
  bash: "running command",
  web_search: "searching the web",
  web_fetch: "fetching a page",
  task: "spawning subagent",
};

function formatTokensApprox(chars: number): string {
  const tokens = Math.max(0, Math.round(chars / 4));
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${Math.round(tokens / 1000)}k`;
}

interface WaitingIndicatorProps {
  tools: DisplayToolCall[];
  hasStreamingText: boolean;
  hasStreamingReasoning: boolean;
  streamedChars: number;
  nowTick: number;
  pendingSteerCount?: number;
  queuedCount?: number;
}

export function WaitingIndicator({
  tools,
  hasStreamingText,
  hasStreamingReasoning,
  streamedChars,
  nowTick,
  pendingSteerCount = 0,
  queuedCount = 0,
}: WaitingIndicatorProps) {
  void nowTick;
  const theme = useTheme();
  const [frameIndex, setFrameIndex] = useState(0);
  const [idlePhrase, setIdlePhrase] = useState(() => GENERIC_PHRASES[0]);

  // Frame timer is independent of the agent state — keeps animation smooth.
  useEffect(() => {
    const t = setInterval(() => {
      setFrameIndex((i) => (i + 1) % SPINNER_FRAMES.length);
    }, 100);
    return () => clearInterval(t);
  }, []);

  // Determine state: active tool > streaming text > streaming reasoning > idle
  const activeTool = [...tools].reverse().find((t) => !t.result);
  const state: "tool" | "text" | "reasoning" | "idle" = activeTool
    ? "tool"
    : hasStreamingText
      ? "text"
      : hasStreamingReasoning
        ? "reasoning"
        : "idle";

  // Rotate idle phrases on a slower cadence; only matters in the idle state.
  useEffect(() => {
    if (state !== "idle") return;
    const t = setInterval(() => {
      setIdlePhrase((current) => {
        const candidates = GENERIC_PHRASES.filter((item) => item !== current);
        return candidates[Math.floor(Math.random() * candidates.length)] || current;
      });
    }, 1500);
    return () => clearInterval(t);
  }, [state]);

  let phrase: string;
  if (state === "tool" && activeTool) {
    phrase =
      TOOL_TARGET_PHRASES[activeTool.name] || `running ${activeTool.name}`;
  } else if (state === "text") {
    phrase = "writing the response";
  } else if (state === "reasoning") {
    phrase = "working through the request";
  } else {
    phrase = idlePhrase;
  }

  const tokenText = streamedChars > 0 ? `↓${formatTokensApprox(streamedChars)} tok` : "";
  const hintParts: string[] = [];
  if (tokenText) hintParts.push(tokenText);
  if (pendingSteerCount > 0) hintParts.push(`${pendingSteerCount} pending steer${pendingSteerCount === 1 ? "" : "s"}`);
  if (queuedCount > 0) hintParts.push(`${queuedCount} queued`);
  hintParts.push("enter steer", "tab queue", "esc stop");

  return (
    <Box>
      <Text color={theme.accent}>{SPINNER_FRAMES[frameIndex]}</Text>
      <Text color={theme.muted}> {phrase} </Text>
      <Text color={theme.muted} dimColor>
        ({hintParts.join(" · ")})
      </Text>
    </Box>
  );
}
