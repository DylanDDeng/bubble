import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { isKeyReleaseEvent } from "./key-events.js";
import { useTheme } from "./theme.js";
import { stripTerminalMouseSequences } from "./terminal-mouse.js";
import type { FeedbackPayload, SubmitResult } from "../feedback/types.js";
import { submitFeedback, FeedbackSubmitError } from "../feedback/submit.js";

interface FeedbackDialogProps {
  /** Pre-collected env + transcript; description is filled in by the user. */
  base: Omit<FeedbackPayload, "description">;
  initialDescription: string;
  onDismiss: () => void;
  onResult: (
    result:
      | { kind: "success"; url: string; number: number }
      | { kind: "error"; message: string }
      | { kind: "cancelled" },
  ) => void;
}

type Stage = "edit" | "submitting" | "done";

export function FeedbackDialog({ base, initialDescription, onDismiss, onResult }: FeedbackDialogProps) {
  const theme = useTheme();
  const [stage, setStage] = useState<Stage>("edit");
  const [description, setDescription] = useState(initialDescription);
  const [cursor, setCursor] = useState(initialDescription.length);
  const [showPreview, setShowPreview] = useState(false);
  const [finalResult, setFinalResult] = useState<
    | { kind: "success"; result: SubmitResult }
    | { kind: "error"; message: string }
    | null
  >(null);

  const transcriptStats = useMemo(() => {
    const total = base.transcript.reduce((sum, m) => sum + m.content.length, 0);
    return { count: base.transcript.length, totalChars: total };
  }, [base.transcript]);

  const insertAtCursor = (text: string) => {
    setDescription((prev) => prev.slice(0, cursor) + text + prev.slice(cursor));
    setCursor((c) => c + text.length);
  };

  const submit = async () => {
    setStage("submitting");
    const payload: FeedbackPayload = { ...base, description: description.trim() };
    try {
      const result = await submitFeedback(payload);
      setFinalResult({ kind: "success", result });
      setStage("done");
      onResult({ kind: "success", url: result.url, number: result.number });
    } catch (err) {
      const message =
        err instanceof FeedbackSubmitError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      setFinalResult({ kind: "error", message });
      setStage("done");
      onResult({ kind: "error", message });
    }
  };

  useInput((input, key) => {
    if (isKeyReleaseEvent(key)) return;
    const strippedMouseInput = stripTerminalMouseSequences(input);
    if (strippedMouseInput !== input) {
      if (!strippedMouseInput) return;
      input = strippedMouseInput;
    }
    if (stage === "submitting") return;

    if (stage === "done") {
      if (key.return || key.escape || input === " ") {
        onDismiss();
      }
      return;
    }

    // edit stage
    if (key.escape) {
      onResult({ kind: "cancelled" });
      onDismiss();
      return;
    }
    if (key.tab) {
      setShowPreview((v) => !v);
      return;
    }
    if (key.ctrl && (input === "d" || input === "s")) {
      if (description.trim().length === 0 && transcriptStats.count === 0) {
        return;
      }
      void submit();
      return;
    }
    if (key.return) {
      insertAtCursor("\n");
      return;
    }
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        setDescription((prev) => prev.slice(0, cursor - 1) + prev.slice(cursor));
        setCursor((c) => Math.max(0, c - 1));
      }
      return;
    }
    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((c) => Math.min(description.length, c + 1));
      return;
    }
    if (key.upArrow || key.downArrow) {
      const before = description.slice(0, cursor);
      const after = description.slice(cursor);
      const beforeLines = before.split("\n");
      const afterLines = after.split("\n");
      const currentCol = beforeLines[beforeLines.length - 1].length;
      if (key.upArrow && beforeLines.length > 1) {
        const prevLine = beforeLines[beforeLines.length - 2];
        const col = Math.min(currentCol, prevLine.length);
        const newCursor =
          before.length - beforeLines[beforeLines.length - 1].length - 1 - (prevLine.length - col);
        setCursor(Math.max(0, newCursor));
      } else if (key.downArrow && afterLines.length > 1) {
        const nextLine = afterLines[1];
        const col = Math.min(currentCol, nextLine.length);
        const newCursor = before.length + afterLines[0].length + 1 + col;
        setCursor(Math.min(description.length, newCursor));
      }
      return;
    }
    if (input && !key.meta) {
      insertAtCursor(input);
    }
  });

  if (stage === "done" && finalResult) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginY={1}>
        {finalResult.kind === "success" ? (
          <>
            <Text color={theme.accent} bold>
              Feedback submitted
            </Text>
            <Box marginTop={1}>
              <Text>
                Thanks! Issue #{finalResult.result.number} created.
              </Text>
            </Box>
            <Box marginTop={1}>
              <Text color={theme.muted}>{finalResult.result.url}</Text>
            </Box>
          </>
        ) : (
          <>
            <Text color={theme.error} bold>
              Feedback failed to submit
            </Text>
            <Box marginTop={1}>
              <Text>{finalResult.message}</Text>
            </Box>
          </>
        )}
        <Box marginTop={1}>
          <Text color={theme.muted}>Press Enter to dismiss</Text>
        </Box>
      </Box>
    );
  }

  if (stage === "submitting") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginY={1}>
        <Text color={theme.accent} bold>
          Sending feedback...
        </Text>
      </Box>
    );
  }

  // edit stage
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginY={1}>
      <Text color={theme.accent} bold>
        Send feedback
      </Text>
      <Box marginTop={1}>
        <Text color={theme.warning}>
          This creates a PUBLIC GitHub issue at DylanDDeng/bubble. Review before sending.
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.muted}>Describe what happened:</Text>
        <Box borderStyle="single" borderColor={theme.muted} paddingX={1} marginTop={0} minHeight={3}>
          <Text>
            {renderWithCursor(description, cursor)}
          </Text>
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.muted}>
          Also included: v{base.version} · {base.platform}/{base.arch} · node {base.nodeVersion} ·{" "}
          {base.provider}/{base.model} · {transcriptStats.count} messages (
          {transcriptStats.totalChars} chars, secrets redacted)
        </Text>
        {showPreview && (
          <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor={theme.muted} paddingX={1}>
            <Text color={theme.muted} bold>
              Payload preview (exactly what will be submitted):
            </Text>
            {base.transcript.map((m, i) => (
              <Box key={i} flexDirection="column" marginTop={1}>
                <Text color={theme.accent}>[{m.role}]</Text>
                <Text>{m.content}</Text>
              </Box>
            ))}
            {base.recentError && (
              <Box flexDirection="column" marginTop={1}>
                <Text color={theme.error}>[recent error]</Text>
                <Text>{base.recentError}</Text>
              </Box>
            )}
          </Box>
        )}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>
          <Text color={theme.accent} bold>Ctrl+D</Text> submit ·{" "}
          <Text color={theme.accent} bold>Tab</Text> {showPreview ? "hide" : "view"} payload ·{" "}
          <Text color={theme.accent} bold>Enter</Text> newline ·{" "}
          <Text color={theme.accent} bold>Esc</Text> cancel
        </Text>
      </Box>
    </Box>
  );
}

function renderWithCursor(text: string, cursor: number): string {
  if (text.length === 0) return "▏";
  return text.slice(0, cursor) + "▏" + text.slice(cursor);
}
