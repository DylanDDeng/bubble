/** @jsxImportSource @opentui/react */
import React, { useMemo, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { useTheme } from "./theme.js";
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

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    if (stage === "submitting") return;

    if (stage === "done") {
      if (key.name === "return" || key.name === "escape" || key.name === " " || key.name === "space") {
        onDismiss();
      }
      return;
    }

    // edit stage
    if (key.name === "escape") {
      onResult({ kind: "cancelled" });
      onDismiss();
      return;
    }
    if (key.name === "tab") {
      setShowPreview((v) => !v);
      return;
    }
    if (key.ctrl && (key.name === "d" || key.name === "s")) {
      if (description.trim().length === 0 && transcriptStats.count === 0) {
        return;
      }
      void submit();
      return;
    }
    if (key.name === "return") {
      insertAtCursor("\n");
      return;
    }
    if (key.name === "backspace" || key.name === "delete") {
      if (cursor > 0) {
        setDescription((prev) => prev.slice(0, cursor - 1) + prev.slice(cursor));
        setCursor((c) => Math.max(0, c - 1));
      }
      return;
    }
    if (key.name === "left") {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.name === "right") {
      setCursor((c) => Math.min(description.length, c + 1));
      return;
    }
    if (key.name === "up" || key.name === "down") {
      const before = description.slice(0, cursor);
      const after = description.slice(cursor);
      const beforeLines = before.split("\n");
      const afterLines = after.split("\n");
      const currentCol = beforeLines[beforeLines.length - 1].length;
      if (key.name === "up" && beforeLines.length > 1) {
        const prevLine = beforeLines[beforeLines.length - 2];
        const col = Math.min(currentCol, prevLine.length);
        const newCursor =
          before.length - beforeLines[beforeLines.length - 1].length - 1 - (prevLine.length - col);
        setCursor(Math.max(0, newCursor));
      } else if (key.name === "down" && afterLines.length > 1) {
        const nextLine = afterLines[1];
        const col = Math.min(currentCol, nextLine.length);
        const newCursor = before.length + afterLines[0].length + 1 + col;
        setCursor(Math.min(description.length, newCursor));
      }
      return;
    }
    if (key.name && key.name.length === 1 && !key.option) {
      insertAtCursor(key.name);
    }
  });

  if (stage === "done" && finalResult) {
    return (
      <box
        style={{
          flexDirection: "column",
          border: true,
          borderColor: theme.accent,
          paddingLeft: 1,
          paddingRight: 1,
          marginTop: 1,
          marginBottom: 1,
        }}
      >
        {finalResult.kind === "success" ? (
          <>
            <text fg={theme.accent} attributes={1}>
              Feedback submitted
            </text>
            <box style={{ marginTop: 1 }}>
              <text>
                Thanks! Issue #{finalResult.result.number} created.
              </text>
            </box>
            <box style={{ marginTop: 1 }}>
              <text fg={theme.muted}>{finalResult.result.url}</text>
            </box>
          </>
        ) : (
          <>
            <text fg="red" attributes={1}>
              Feedback failed to submit
            </text>
            <box style={{ marginTop: 1 }}>
              <text>{finalResult.message}</text>
            </box>
          </>
        )}
        <box style={{ marginTop: 1 }}>
          <text fg={theme.muted}>Press Enter to dismiss</text>
        </box>
      </box>
    );
  }

  if (stage === "submitting") {
    return (
      <box
        style={{
          flexDirection: "column",
          border: true,
          borderColor: theme.accent,
          paddingLeft: 1,
          paddingRight: 1,
          marginTop: 1,
          marginBottom: 1,
        }}
      >
        <text fg={theme.accent} attributes={1}>
          Sending feedback...
        </text>
      </box>
    );
  }

  // edit stage
  return (
    <box
      style={{
        flexDirection: "column",
        border: true,
        borderColor: theme.accent,
        paddingLeft: 1,
        paddingRight: 1,
        marginTop: 1,
        marginBottom: 1,
      }}
    >
      <text fg={theme.accent} attributes={1}>
        Send feedback
      </text>
      <box style={{ marginTop: 1 }}>
        <text fg="yellow">
          This creates a PUBLIC GitHub issue at DylanDDeng/bubble. Review before sending.
        </text>
      </box>
      <box style={{ marginTop: 1, flexDirection: "column" }}>
        <text fg={theme.muted}>Describe what happened:</text>
        <box
          style={{
            border: true,
            borderColor: theme.muted,
            paddingLeft: 1,
            paddingRight: 1,
            marginTop: 0,
            minHeight: 3,
          }}
        >
          <text>
            {renderWithCursor(description, cursor)}
          </text>
        </box>
      </box>
      <box style={{ marginTop: 1, flexDirection: "column" }}>
        <text fg={theme.muted}>
          Also included: v{base.version} · {base.platform}/{base.arch} · node {base.nodeVersion} ·{" "}
          {base.provider}/{base.model} · {transcriptStats.count} messages (
          {transcriptStats.totalChars} chars, secrets redacted)
        </text>
        {showPreview && (
          <box
            style={{
              flexDirection: "column",
              marginTop: 1,
              border: true,
              borderColor: theme.muted,
              paddingLeft: 1,
              paddingRight: 1,
            }}
          >
            <text fg={theme.muted} attributes={1}>
              Payload preview (exactly what will be submitted):
            </text>
            {base.transcript.map((m, i) => (
              <box key={i} style={{ flexDirection: "column", marginTop: 1 }}>
                <text fg={theme.accent}>[{m.role}]</text>
                <text>{m.content}</text>
              </box>
            ))}
            {base.recentError && (
              <box style={{ flexDirection: "column", marginTop: 1 }}>
                <text fg="red">[recent error]</text>
                <text>{base.recentError}</text>
              </box>
            )}
          </box>
        )}
      </box>
      <box style={{ marginTop: 1, flexDirection: "row" }}>
        <text fg={theme.muted}>
          <text fg={theme.accent} attributes={1}>Ctrl+D</text>
          {" submit · "}
          <text fg={theme.accent} attributes={1}>Tab</text>
          {" "}{showPreview ? "hide" : "view"}{" payload · "}
          <text fg={theme.accent} attributes={1}>Enter</text>
          {" newline · "}
          <text fg={theme.accent} attributes={1}>Esc</text>
          {" cancel"}
        </text>
      </box>
    </box>
  );
}

function renderWithCursor(text: string, cursor: number): string {
  if (text.length === 0) return "▏";
  return text.slice(0, cursor) + "▏" + text.slice(cursor);
}