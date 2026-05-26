/** @jsxImportSource @opentui/react */
import React, { useMemo, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { QuestionAnswer, QuestionRequest } from "../question/index.js";
import { useTheme } from "./theme.js";

interface QuestionDialogProps {
  request: QuestionRequest;
  onSubmit: (answers: QuestionAnswer[]) => void;
  onCancel: () => void;
}

export function QuestionDialog({ request, onSubmit, onCancel }: QuestionDialogProps) {
  const theme = useTheme();
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState(0);
  const [custom, setCustom] = useState("");
  const [answers, setAnswers] = useState<QuestionAnswer[]>(() => request.questions.map(() => []));
  const question = request.questions[index];
  const options = question?.options ?? [];
  const canUseCustom = question?.custom !== false;
  const isMultiple = question?.multiple === true;
  const totalTabs = request.questions.length;

  const currentAnswer = useMemo(() => answers[index] ?? [], [answers, index]);

  const commitQuestion = () => {
    const option = options[selected]?.label;
    const customAnswer = custom.trim();
    const nextAnswer = customAnswer
      ? [customAnswer]
      : isMultiple
        ? currentAnswer
        : option
          ? [option]
          : [];
    const nextAnswers = answers.map((answer, i) => i === index ? nextAnswer : answer);
    if (index < request.questions.length - 1) {
      setAnswers(nextAnswers);
      setIndex((i) => i + 1);
      setSelected(0);
      setCustom("");
      return;
    }
    onSubmit(nextAnswers);
  };

  const toggleCurrentOption = () => {
    const option = options[selected]?.label;
    if (!option) return;
    if (!isMultiple) {
      setAnswers((prev) => prev.map((answer, i) => i === index ? [option] : answer));
      return;
    }
    setAnswers((prev) => prev.map((answer, i) => {
      if (i !== index) return answer;
      return answer.includes(option)
        ? answer.filter((item) => item !== option)
        : [...answer, option];
    }));
  };

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    if (key.name === "escape") {
      onCancel();
      return;
    }
    if (key.name === "left" && index > 0) {
      setIndex((i) => i - 1);
      setSelected(0);
      setCustom("");
      return;
    }
    if (key.name === "right" && index < totalTabs - 1) {
      setIndex((i) => i + 1);
      setSelected(0);
      setCustom("");
      return;
    }
    if (key.name === "up") {
      setSelected((i) => Math.max(0, i - 1));
      return;
    }
    if (key.name === "down") {
      setSelected((i) => Math.min(Math.max(0, options.length - 1), i + 1));
      return;
    }
    if (key.name === "tab" || key.name === " " || key.name === "space") {
      toggleCurrentOption();
      return;
    }
    if (key.name === "return") {
      commitQuestion();
      return;
    }
    if (key.name === "backspace" || key.name === "delete") {
      setCustom((value) => value.slice(0, -1));
      return;
    }
    if (canUseCustom && key.name && key.name.length === 1 && !key.ctrl && !key.option) {
      setCustom((value) => value + key.name);
    }
  });

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
        {`Question ${totalTabs > 1 ? `${index + 1}/${totalTabs}` : ""}`}
      </text>
      <box style={{ marginTop: 1 }}>
        <text>{question?.question ?? "The agent is asking for input."}</text>
      </box>
      <box style={{ flexDirection: "column", marginTop: 1 }}>
        {options.map((option, optionIndex) => {
          const isSelected = optionIndex === selected;
          const isChecked = currentAnswer.includes(option.label);
          return (
            <box key={`${option.label}-${optionIndex}`} style={{ flexDirection: "column" }}>
              <text fg={isSelected ? theme.accent : undefined}>
                {isSelected ? "> " : "  "}
                {isMultiple ? `[${isChecked ? "x" : " "}] ` : ""}
                {option.label}
              </text>
              {option.description && (
                <box style={{ marginLeft: 4 }}>
                  <text fg={theme.muted}>{option.description}</text>
                </box>
              )}
            </box>
          );
        })}
      </box>
      {canUseCustom && (
        <box style={{ marginTop: 1 }}>
          <text fg={custom ? undefined : theme.muted}>
            {`Custom: ${custom || "type to answer..."}`}
          </text>
        </box>
      )}
      <box style={{ marginTop: 1 }}>
        <text fg={theme.muted}>
          ↑↓ choose · Tab/Space toggle · Enter submit · Esc dismiss
        </text>
      </box>
    </box>
  );
}