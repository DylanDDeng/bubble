import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";

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

  useInput((input, key) => {
    if (amending) {
      if (key.escape) {
        setAmending(false);
        setAmendText("");
        return;
      }
      if (key.return) {
        const editedValue = focused.editableValue ? currentValue : undefined;
        onSubmit(focused.id, { feedback: amendText.trim() || undefined, editedValue });
        return;
      }
      if (key.backspace || key.delete) {
        setAmendText((prev) => prev.slice(0, -1));
        return;
      }
      if (input) {
        setAmendText((prev) => prev + input);
      }
      return;
    }

    if (key.escape) {
      onCancel();
      return;
    }

    // Vertical nav always works regardless of editable value, so the user can
    // still move off an option they don't want.
    if (key.upArrow) {
      setFocusIndex((i) => (i - 1 + options.length) % options.length);
      return;
    }
    if (key.downArrow) {
      setFocusIndex((i) => (i + 1) % options.length);
      return;
    }
    if (key.return) {
      const editedValue = focused.editableValue ? currentValue : undefined;
      onSubmit(focused.id, { editedValue });
      return;
    }
    if (key.tab && canAmend) {
      setAmending(true);
      setAmendText("");
      return;
    }

    // When the focused option has an editable value, plain keypresses mutate it.
    if (hasEditableValue) {
      if (key.backspace || key.delete) {
        setEditedValues((prev) => ({ ...prev, [focused.id]: (prev[focused.id] ?? "").slice(0, -1) }));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setEditedValues((prev) => ({ ...prev, [focused.id]: (prev[focused.id] ?? "") + input }));
      }
    }
  });

  return (
    <Box flexDirection="column">
      {options.map((option, idx) => {
        const isFocused = idx === focusIndex;
        const value = option.editableValue ? editedValues[option.id] ?? "" : undefined;

        if (isFocused && amending) {
          return (
            <Box key={option.id}>
              <Text color={theme.accent}>{"› "}</Text>
              <Text bold>{option.label}:</Text>
              <Text> </Text>
              <Text color={amendText ? undefined : theme.muted}>
                {amendText || option.amendPlaceholder || "type feedback…"}
              </Text>
              <Text backgroundColor="white" color="black"> </Text>
            </Box>
          );
        }

        return (
          <Box key={option.id}>
            <Text color={isFocused ? theme.accent : theme.muted}>{isFocused ? "› " : "  "}</Text>
            <Text bold={isFocused} color={isFocused ? undefined : theme.muted}>
              {option.label}
            </Text>
            {option.editableValue && (
              <>
                <Text color={theme.muted}> </Text>
                <Text color={isFocused ? theme.accent : theme.muted}>[</Text>
                <Text color={isFocused ? undefined : theme.muted}>
                  {value || option.editableValue.placeholder || ""}
                </Text>
                {isFocused && (
                  <Text backgroundColor="white" color="black"> </Text>
                )}
                <Text color={isFocused ? theme.accent : theme.muted}>]</Text>
              </>
            )}
            {option.description && (
              <>
                <Text> </Text>
                <Text color={theme.muted}>{option.description}</Text>
              </>
            )}
          </Box>
        );
      })}
      {hint && (
        <Box marginTop={1}>
          <Text color={theme.muted}>{hint}</Text>
        </Box>
      )}
    </Box>
  );
}
