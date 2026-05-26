/** @jsxImportSource @opentui/react */
import React, { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { useTheme } from "../theme.js";

export interface ApprovalOption {
  /** Stable identifier returned to the parent. */
  id: string;
  /** Primary label shown in the menu. */
  label: string;
  /** Dim description appended after the label. */
  description?: string;
  /** If true, Tab on this option turns it into a feedback input. */
  allowAmend?: boolean;
  /** Placeholder shown in the amend input. */
  amendPlaceholder?: string;
  /**
   * If set, this option has an inline-editable data value (rendered right
   * after `label`). When the option is focused, typing modifies the value;
   * backspace removes the last character. Use-case: "Yes, and don't ask
   * again for `<prefix>`" — the prefix is editable before submit.
   */
  editableValue?: {
    initial: string;
    placeholder?: string;
  };
}

export type ApprovalSubmit = (
  optionId: string,
  extras: { feedback?: string; editedValue?: string },
) => void;

interface ApprovalSelectProps {
  options: ApprovalOption[];
  onSubmit: ApprovalSubmit;
  onCancel: () => void;
  hint?: string;
  initialIndex?: number;
}

export function ApprovalSelect({
  options,
  onSubmit,
  onCancel,
  hint,
  initialIndex = 0,
}: ApprovalSelectProps) {
  const theme = useTheme();
  const [focusIndex, setFocusIndex] = useState(
    Math.max(0, Math.min(initialIndex, options.length - 1)),
  );
  const [amending, setAmending] = useState(false);
  const [amendText, setAmendText] = useState("");
  // Map of option.id → current edited value. Populated lazily so navigating
  // away and back preserves edits.
  const [editedValues, setEditedValues] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const opt of options) {
      if (opt.editableValue) seed[opt.id] = opt.editableValue.initial;
    }
    return seed;
  });

  const focused = options[focusIndex];
  const canAmend = !!focused?.allowAmend;
  const hasEditableValue = !!focused?.editableValue;
  const currentValue = focused?.editableValue ? editedValues[focused.id] ?? "" : "";

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    if (amending) {
      if (key.name === "escape") {
        setAmending(false);
        setAmendText("");
        return;
      }
      if (key.name === "return") {
        const editedValue = focused.editableValue ? currentValue : undefined;
        onSubmit(focused.id, { feedback: amendText.trim() || undefined, editedValue });
        return;
      }
      if (key.name === "backspace" || key.name === "delete") {
        setAmendText((prev) => prev.slice(0, -1));
        return;
      }
      if (key.name && key.name.length === 1) {
        setAmendText((prev) => prev + key.name);
      }
      return;
    }

    if (key.name === "escape") {
      onCancel();
      return;
    }

    // Vertical nav always works regardless of editable value, so the user can
    // still move off an option they don't want.
    if (key.name === "up") {
      setFocusIndex((i) => (i - 1 + options.length) % options.length);
      return;
    }
    if (key.name === "down") {
      setFocusIndex((i) => (i + 1) % options.length);
      return;
    }
    if (key.name === "return") {
      const editedValue = focused.editableValue ? currentValue : undefined;
      onSubmit(focused.id, { editedValue });
      return;
    }
    if (key.name === "tab" && canAmend) {
      setAmending(true);
      setAmendText("");
      return;
    }

    // When the focused option has an editable value, plain keypresses mutate it.
    if (hasEditableValue) {
      if (key.name === "backspace" || key.name === "delete") {
        setEditedValues((prev) => ({ ...prev, [focused.id]: (prev[focused.id] ?? "").slice(0, -1) }));
        return;
      }
      if (key.name && key.name.length === 1 && !key.ctrl && !key.option) {
        setEditedValues((prev) => ({ ...prev, [focused.id]: (prev[focused.id] ?? "") + key.name }));
      }
    }
  });

  return (
    <box style={{ flexDirection: "column" }}>
      {options.map((option, idx) => {
        const isFocused = idx === focusIndex;
        const value = option.editableValue ? editedValues[option.id] ?? "" : undefined;

        if (isFocused && amending) {
          return (
            <box key={option.id} style={{ flexDirection: "row" }}>
              <text fg={theme.accent}>{"› "}</text>
              <text attributes={1}>{`${option.label}:`}</text>
              <text> </text>
              <text fg={amendText ? undefined : theme.muted}>
                {amendText || option.amendPlaceholder || "type feedback…"}
              </text>
              <text bg="white" fg="black"> </text>
            </box>
          );
        }

        return (
          <box key={option.id} style={{ flexDirection: "row" }}>
            <text fg={isFocused ? theme.accent : theme.muted}>{isFocused ? "› " : "  "}</text>
            <text attributes={isFocused ? 1 : 0} fg={isFocused ? undefined : theme.muted}>
              {option.label}
            </text>
            {option.editableValue && (
              <>
                <text fg={theme.muted}> </text>
                <text fg={isFocused ? theme.accent : theme.muted}>[</text>
                <text fg={isFocused ? undefined : theme.muted}>
                  {value || option.editableValue.placeholder || ""}
                </text>
                {isFocused && (
                  <text bg="white" fg="black"> </text>
                )}
                <text fg={isFocused ? theme.accent : theme.muted}>]</text>
              </>
            )}
            {option.description && (
              <>
                <text> </text>
                <text fg={theme.muted}>{option.description}</text>
              </>
            )}
          </box>
        );
      })}
      {hint && (
        <box style={{ marginTop: 1 }}>
          <text fg={theme.muted}>{hint}</text>
        </box>
      )}
    </box>
  );
}