import type { ToolRegistryEntry, ToolResult } from "../types.js";
import type { QuestionAnswer, QuestionController, QuestionPrompt } from "../question/index.js";
import { QuestionRejectedError } from "../question/index.js";
import { normalizeQuestionInlineText } from "../question/normalize.js";

export function createQuestionTool(controller: QuestionController): ToolRegistryEntry {
  return {
    name: "question",
    readOnly: true,
    effect: "read",
    requiresApproval: true,
    description: `Ask the user one or more structured questions during execution.

Use this when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices
4. Offer choices about what direction to take

Usage notes:
- Each question needs a short header, complete question text, and concise options.
- When custom is enabled (default), the UI adds "Type your own answer"; do not include "Other" or catch-all options yourself.
- Answers are returned as arrays of labels; set multiple: true when more than one answer may be selected.
- If you recommend a specific option, make it the first option and add "(Recommended)" to the label.
- Ask only targeted questions that unblock real work; do not ask "Should I proceed?".`,
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "Questions to ask the user.",
          items: {
            type: "object",
            properties: {
              header: {
                type: "string",
                description: "Very short label for this question, ideally 1-4 words.",
              },
              question: {
                type: "string",
                description: "Complete user-facing question.",
              },
              options: {
                type: "array",
                description: "Available choices. Do not include Other when custom is enabled.",
                items: {
                  type: "object",
                  properties: {
                    label: {
                      type: "string",
                      description: "Display label, concise and selectable.",
                    },
                    description: {
                      type: "string",
                      description: "Short explanation of the choice and its tradeoff.",
                    },
                  },
                  required: ["label", "description"],
                  additionalProperties: false,
                },
              },
              multiple: {
                type: "boolean",
                description: "Allow selecting multiple choices.",
              },
              custom: {
                type: "boolean",
                description: "Allow typing a custom answer. Defaults to true.",
              },
            },
            required: ["header", "question", "options"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
    async execute(args, ctx): Promise<ToolResult> {
      const normalized = normalizeQuestions(args.questions);
      if ("error" in normalized) {
        return { content: normalized.error, isError: true };
      }

      try {
        const answers = await controller.ask({
          sessionID: ctx.sessionID,
          questions: normalized.questions,
          tool: ctx.toolCall ? { callID: ctx.toolCall.id } : undefined,
        });

        return {
          content: formatQuestionToolResult(normalized.questions, answers),
          status: "success",
          metadata: {
            kind: "question",
            questions: normalized.questions,
            answers,
          },
        };
      } catch (err) {
        const message = err instanceof QuestionRejectedError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
        return {
          content: `QuestionRejectedError: ${message}`,
          isError: true,
          status: "blocked",
          metadata: {
            kind: "question",
            questions: normalized.questions,
            rejected: true,
          },
        };
      }
    },
  };
}

function normalizeQuestions(input: unknown): { questions: QuestionPrompt[] } | { error: string } {
  if (!Array.isArray(input) || input.length === 0) {
    return { error: "Error: questions must be a non-empty array." };
  }
  if (input.length > 3) {
    return { error: "Error: ask at most 3 questions at a time." };
  }

  const questions: QuestionPrompt[] = [];
  for (let index = 0; index < input.length; index++) {
    const raw = input[index];
    if (!raw || typeof raw !== "object") {
      return { error: `Error: question at index ${index} must be an object.` };
    }
    const q = raw as Record<string, unknown>;
    const header = typeof q.header === "string" ? normalizeQuestionInlineText(q.header) : "";
    const question = typeof q.question === "string" ? normalizeQuestionInlineText(q.question) : "";
    const options = q.options;
    if (!header) return { error: `Error: question at index ${index} has an empty header.` };
    if (!question) return { error: `Error: question at index ${index} has empty question text.` };
    if (!Array.isArray(options) || options.length === 0) {
      return { error: `Error: question at index ${index} needs at least one option.` };
    }
    if (options.length > 9) {
      return { error: `Error: question at index ${index} has too many options; max is 9.` };
    }

    const normalizedOptions: QuestionPrompt["options"] = [];
    for (let optIndex = 0; optIndex < options.length; optIndex++) {
      const opt = options[optIndex];
      if (!opt || typeof opt !== "object") {
        return { error: `Error: option ${optIndex + 1} for "${header}" must be an object.` };
      }
      const value = opt as Record<string, unknown>;
      const label = typeof value.label === "string" ? normalizeQuestionInlineText(value.label) : "";
      const description = typeof value.description === "string" ? normalizeQuestionInlineText(value.description) : "";
      if (!label) return { error: `Error: option ${optIndex + 1} for "${header}" has empty label.` };
      if (!description) return { error: `Error: option "${label}" for "${header}" has empty description.` };
      normalizedOptions.push({ label, description });
    }

    questions.push({
      header,
      question,
      options: normalizedOptions,
      multiple: q.multiple === true,
      custom: q.custom === false ? false : undefined,
    });
  }

  return { questions };
}

function formatQuestionToolResult(questions: QuestionPrompt[], answers: QuestionAnswer[]) {
  const formatted = questions
    .map((question, index) => {
      const answer = answers[index]?.length ? answers[index].join(", ") : "Unanswered";
      return `"${question.question}"="${answer}"`;
    })
    .join(", ");
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`;
}
