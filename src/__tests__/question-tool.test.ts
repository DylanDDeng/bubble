import { describe, expect, it } from "vitest";
import { QuestionController } from "../question/index.js";
import { createQuestionTool } from "../tools/question.js";

const args = {
  questions: [
    {
      header: "Scope",
      question: "How broad should the change be?",
      options: [
        { label: "Focused (Recommended)", description: "Only touch the relevant path" },
        { label: "Broad", description: "Refactor adjacent paths too" },
      ],
    },
  ],
};

describe("question tool", () => {
  it("is read-only so it can be used in plan mode", () => {
    const tool = createQuestionTool(new QuestionController());
    expect(tool.readOnly).toBe(true);
  });

  it("waits for a controller reply and returns model-readable answers", async () => {
    const controller = new QuestionController();
    const tool = createQuestionTool(controller);
    const pendingSeen = new Promise<string>((resolve) => {
      const unsubscribe = controller.subscribe((event) => {
        if (event.type !== "asked") return;
        unsubscribe();
        resolve(event.request.id);
      });
    });

    const resultPromise = tool.execute(args, {
      cwd: "/tmp",
      sessionID: "session-a",
      toolCall: { id: "call-1", name: "question" },
    });
    const requestID = await pendingSeen;
    expect(controller.list("session-a")[0].tool?.callID).toBe("call-1");
    controller.reply(requestID, [["Focused (Recommended)"]]);

    const result = await resultPromise;
    expect(result.isError).toBeFalsy();
    expect(result.metadata?.kind).toBe("question");
    expect(result.metadata?.answers).toEqual([["Focused (Recommended)"]]);
    expect(result.content).toContain('"How broad should the change be?"="Focused (Recommended)"');
  });

  it("returns a typed tool error when the user rejects the question", async () => {
    const controller = new QuestionController();
    const tool = createQuestionTool(controller);
    const pendingSeen = new Promise<string>((resolve) => {
      const unsubscribe = controller.subscribe((event) => {
        if (event.type !== "asked") return;
        unsubscribe();
        resolve(event.request.id);
      });
    });

    const resultPromise = tool.execute(args, { cwd: "/tmp" });
    controller.reject(await pendingSeen);

    const result = await resultPromise;
    expect(result.isError).toBe(true);
    expect(result.content).toContain("QuestionRejectedError");
    expect(result.metadata?.rejected).toBe(true);
  });

  it("validates question shape before asking the user", async () => {
    const controller = new QuestionController();
    const tool = createQuestionTool(controller);
    const result = await tool.execute({ questions: [] }, { cwd: "/tmp" });

    expect(result.isError).toBe(true);
    expect(controller.list()).toEqual([]);
  });

  it("normalizes CR-rich model copy before opening and persisting a question", async () => {
    const controller = new QuestionController();
    const tool = createQuestionTool(controller);
    const resultPromise = tool.execute({
      questions: [{
        header: "扩充\r范围",
        question: "想扩多大范围\r？",
        options: [{
          label: "混合套餐\r(Recommended)",
          description: "上游精选\r+\r手写独占热门",
        }],
      }],
    }, { cwd: "/tmp" });
    const [pending] = controller.list();

    expect(pending.questions[0]).toMatchObject({
      header: "扩充 范围",
      question: "想扩多大范围？",
      options: [{
        label: "混合套餐 (Recommended)",
        description: "上游精选 + 手写独占热门",
      }],
    });
    controller.reply(pending.id, [["混合套餐 (Recommended)"]]);

    const result = await resultPromise;
    expect(result.metadata?.questions).toEqual(pending.questions);
    expect(result.content).not.toMatch(/[\r\n]/);
  });
});
