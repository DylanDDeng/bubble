import { describe, expect, it, vi } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@bubblebrain-ai/pi-tui";
import type { QuestionRequest } from "../question/types.js";
import { QuestionDialogComponent } from "../tui/components/question-dialog.js";

const request: QuestionRequest = {
  id: "question-1",
  createdAt: 1,
  questions: [
    {
      header: "Permission",
      question: "刚才那条 echo 命令弹出权限批准卡了吗？",
      options: [
        { label: "看到了，就是权限弹窗", description: "你看到了 Allow once / Reject / Always-approve 那些选项" },
        { label: "没弹，命令直接跑了", description: "当前可能是 always-approve 或 auto 模式" },
        { label: "弹了，但我想再看一次", description: "我可以再请求一次权限" },
        { label: "想看问答卡长什么样", description: "你现在看到的就是 ask_user_question" },
      ],
    },
  ],
};

describe("question dialog", () => {
  it("renders the complete request as a full-width bottom sheet at responsive sizes", () => {
    for (const [width, rows] of [[100, 20], [32, 8], [16, 4]] as const) {
      const dialog = new QuestionDialogComponent(request, () => rows);
      const rendered = dialog.render(width);
      expect(rendered.length).toBeLessThanOrEqual(rows);
      expect(rendered.every((line) => visibleWidth(line) === width)).toBe(true);
      const plain = rendered.map(stripTerminalSequences).join("\n");
      expect(plain).toContain("1 (○)");
    }

    const plain = new QuestionDialogComponent(request, () => 20)
      .render(100)
      .map(stripTerminalSequences)
      .join("\n");
    expect(plain).toContain("刚才那条 echo 命令弹出权限批准卡了吗？");
    expect(plain).toContain("Always-approve");
    expect(plain).toContain("z (○) Type your answer here");
    expect(plain).toContain("Enter:submit");
  });

  it("submits a highlighted option or a typed custom answer", () => {
    const selected = vi.fn();
    const optionDialog = new QuestionDialogComponent(request, () => 20);
    optionDialog.onSubmit = selected;
    optionDialog.handleInput("\x1b[B");
    optionDialog.handleInput("\r");
    expect(selected).toHaveBeenCalledWith([["没弹，命令直接跑了"]]);

    const customDialog = new QuestionDialogComponent(request, () => 20);
    customDialog.onSubmit = selected;
    customDialog.handleInput("我的自定义回答");
    customDialog.handleInput("\x7f");
    customDialog.handleInput("答");
    customDialog.handleInput("\r");
    expect(selected).toHaveBeenLastCalledWith([["我的自定义回答"]]);
  });

  it("restores a custom answer after navigating away and back", () => {
    const multipleQuestions: QuestionRequest = {
      id: "question-navigation",
      createdAt: 2,
      questions: [
        {
          header: "Reason",
          question: "What should change?",
          options: [{ label: "Nothing", description: "Keep the current behavior" }],
        },
        {
          header: "Confirm",
          question: "Continue?",
          options: [{ label: "Yes", description: "Apply the answer" }],
          custom: false,
        },
      ],
    };
    const submitted = vi.fn();
    const dialog = new QuestionDialogComponent(multipleQuestions, () => 20);
    dialog.onSubmit = submitted;

    dialog.handleInput("保留这个自定义答案");
    dialog.handleInput("\x1b[C");
    dialog.handleInput("\x1b[D");
    expect(dialog.render(100).map(stripTerminalSequences).join("\n"))
      .toContain("保留这个自定义答案");

    dialog.handleInput("\r");
    dialog.handleInput("\r");
    expect(submitted).toHaveBeenCalledWith([["保留这个自定义答案"], ["Yes"]]);
  });

  it("accepts multiline paste, deletes one grapheme, and rejects terminal controls", () => {
    const submitted = vi.fn();
    const dialog = new QuestionDialogComponent(request, () => 20);
    dialog.onSubmit = submitted;
    dialog.handleInput("first\nsecond\t👨‍👩‍👧‍👦");
    dialog.handleInput("\x7f");
    dialog.handleInput("\u001b]8;;https://example.com\u0007unsafe\u001b]8;;\u0007");
    dialog.handleInput("\r");
    expect(submitted).toHaveBeenCalledWith([["first second"]]);
  });

  it("preserves multi-select answers while advancing through multiple questions", () => {
    const multi: QuestionRequest = {
      id: "question-2",
      createdAt: 2,
      questions: [
        {
          header: "Scope",
          question: "Select scopes",
          multiple: true,
          custom: false,
          options: [
            { label: "Code", description: "Implementation" },
            { label: "Tests", description: "Regression coverage" },
          ],
        },
        {
          header: "Note",
          question: "Add a note?",
          options: [{ label: "No note", description: "Continue without one" }],
        },
      ],
    };
    const submitted = vi.fn();
    const dialog = new QuestionDialogComponent(multi, () => 20);
    dialog.onSubmit = submitted;
    dialog.handleInput(" ");
    dialog.handleInput("\x1b[B");
    dialog.handleInput(" ");
    dialog.handleInput("\r");
    dialog.handleInput("custom note");
    dialog.handleInput("\r");
    expect(submitted).toHaveBeenCalledWith([["Code", "Tests"], ["custom note"]]);
  });

  it("dismisses through Escape, Ctrl+C, or Shift+X", () => {
    const cancelled = vi.fn();
    const dialog = new QuestionDialogComponent(request, () => 20);
    dialog.onCancel = cancelled;
    dialog.handleInput("\x1b");
    dialog.handleInput("\x03");
    dialog.handleInput("X");
    expect(cancelled).toHaveBeenCalledTimes(3);
  });

  it("never exceeds terminals as short as one to three rows", () => {
    for (const rows of [1, 2, 3]) {
      for (const width of [1, 2, 12]) {
        const rendered = new QuestionDialogComponent(request, () => rows).render(width);
        expect(rendered.length).toBeLessThanOrEqual(rows === 1 ? 1 : rows - 1);
        expect(rendered.every((line) => visibleWidth(line) === width)).toBe(true);
      }
    }
  });
});
