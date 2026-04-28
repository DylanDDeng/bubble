import { describe, expect, it } from "vitest";
import { QuestionController, QuestionRejectedError } from "../question/index.js";

const questions = [
  {
    header: "Mode",
    question: "Which mode should Bubble use?",
    options: [
      { label: "Fast", description: "Prioritize speed" },
      { label: "Careful", description: "Prioritize validation" },
    ],
  },
];

describe("QuestionController", () => {
  it("adds pending question requests and resolves them with answers", async () => {
    const controller = new QuestionController();
    const events: string[] = [];
    controller.subscribe((event) => events.push(event.type));

    const promise = controller.ask({ sessionID: "session-a", questions });
    const pending = controller.list("session-a");

    expect(pending).toHaveLength(1);
    expect(pending[0].questions[0].header).toBe("Mode");

    expect(controller.reply(pending[0].id, [["Careful"]])).toBe(true);
    await expect(promise).resolves.toEqual([["Careful"]]);
    expect(controller.list("session-a")).toEqual([]);
    expect(events).toEqual(["asked", "replied"]);
  });

  it("rejects pending questions with a typed error", async () => {
    const controller = new QuestionController();
    const promise = controller.ask({ questions });
    const [pending] = controller.list();

    expect(controller.reject(pending.id)).toBe(true);
    await expect(promise).rejects.toBeInstanceOf(QuestionRejectedError);
    expect(controller.list()).toEqual([]);
  });

  it("scopes list by session id without affecting global pending state", () => {
    const controller = new QuestionController();
    void controller.ask({ sessionID: "a", questions }).catch(() => undefined);
    void controller.ask({ sessionID: "b", questions }).catch(() => undefined);

    expect(controller.list()).toHaveLength(2);
    expect(controller.list("a")).toHaveLength(1);
    expect(controller.list("b")).toHaveLength(1);
    controller.rejectAll();
  });
});

