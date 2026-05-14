import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { QuestionAnswer, QuestionRequest } from "../question/index.js";
import { theme } from "./theme.js";

interface QuestionDialogProps {
  request: QuestionRequest;
  onSubmit: (answers: QuestionAnswer[]) => void;
  onCancel: () => void;
}

export function QuestionDialog({ request, onSubmit, onCancel }: QuestionDialogProps) {
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

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.leftArrow && index > 0) {
      setIndex((i) => i - 1);
      setSelected(0);
      setCustom("");
      return;
    }
    if (key.rightArrow && index < totalTabs - 1) {
      setIndex((i) => i + 1);
      setSelected(0);
      setCustom("");
      return;
    }
    if (key.upArrow) {
      setSelected((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((i) => Math.min(Math.max(0, options.length - 1), i + 1));
      return;
    }
    if (key.tab || input === " ") {
      toggleCurrentOption();
      return;
    }
    if (key.return) {
      commitQuestion();
      return;
    }
    if (key.backspace || key.delete) {
      setCustom((value) => value.slice(0, -1));
      return;
    }
    if (canUseCustom && input && !key.ctrl && !key.meta) {
      setCustom((value) => value + input);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginY={1}>
      <Text color={theme.accent} bold>
        Question {totalTabs > 1 ? `${index + 1}/${totalTabs}` : ""}
      </Text>
      <Box marginTop={1}>
        <Text>{question?.question ?? "The agent is asking for input."}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {options.map((option, optionIndex) => {
          const isSelected = optionIndex === selected;
          const isChecked = currentAnswer.includes(option.label);
          return (
            <Box key={`${option.label}-${optionIndex}`} flexDirection="column">
              <Text color={isSelected ? theme.accent : undefined}>
                {isSelected ? "> " : "  "}
                {isMultiple ? `[${isChecked ? "x" : " "}] ` : ""}
                {option.label}
              </Text>
              {option.description && (
                <Box marginLeft={4}>
                  <Text color={theme.muted} dimColor>{option.description}</Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
      {canUseCustom && (
        <Box marginTop={1}>
          <Text color={custom ? undefined : theme.muted}>
            Custom: {custom || "type to answer..."}
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={theme.muted}>
          ↑↓ choose · Tab/Space toggle · Enter submit · Esc dismiss
        </Text>
      </Box>
    </Box>
  );
}
