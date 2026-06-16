import { describe, expect, it } from "vitest";
import { parseGoalCommand, parseBudgetValue } from "../goal/command.js";

describe("parseGoalCommand", () => {
  it("treats a bare /goal as show", () => {
    expect(parseGoalCommand("/goal")).toEqual({ kind: "show" });
    expect(parseGoalCommand("/goal   ")).toEqual({ kind: "show" });
  });

  it("parses subcommands", () => {
    expect(parseGoalCommand("/goal clear")).toEqual({ kind: "clear" });
    expect(parseGoalCommand("/goal pause")).toEqual({ kind: "pause" });
    expect(parseGoalCommand("/goal resume")).toEqual({ kind: "resume" });
  });

  it("rejects arguments on argument-less subcommands", () => {
    expect(parseGoalCommand("/goal clear now").error).toMatch(/takes no arguments/);
  });

  it("parses edit with a new objective", () => {
    expect(parseGoalCommand("/goal edit ship the release")).toEqual({
      kind: "edit",
      objective: "ship the release",
    });
    expect(parseGoalCommand("/goal edit").error).toMatch(/Usage/);
  });

  it("parses a plain objective as set", () => {
    expect(parseGoalCommand("/goal make all tests pass")).toEqual({
      kind: "set",
      objective: "make all tests pass",
      tokenBudget: undefined,
    });
  });

  it("extracts --budget from anywhere and strips it from the objective", () => {
    expect(parseGoalCommand("/goal refactor auth --budget 200000")).toEqual({
      kind: "set",
      objective: "refactor auth",
      tokenBudget: 200000,
    });
    expect(parseGoalCommand("/goal --budget=200k refactor auth")).toEqual({
      kind: "set",
      objective: "refactor auth",
      tokenBudget: 200000,
    });
    expect(parseGoalCommand("/goal fix bug --budget 1.5m now")).toEqual({
      kind: "set",
      objective: "fix bug now",
      tokenBudget: 1_500_000,
    });
  });

  it("reports invalid budgets", () => {
    expect(parseGoalCommand("/goal x --budget abc").error).toMatch(/Invalid --budget/);
  });

  it("requires an objective for set", () => {
    expect(parseGoalCommand("/goal --budget 100").error).toMatch(/Usage/);
  });
});

describe("parseBudgetValue", () => {
  it("parses plain, k, and m suffixes", () => {
    expect(parseBudgetValue("200000")).toBe(200000);
    expect(parseBudgetValue("200k")).toBe(200000);
    expect(parseBudgetValue("1.5m")).toBe(1_500_000);
    expect(parseBudgetValue("2K")).toBe(2000);
    expect(parseBudgetValue("abc")).toBeUndefined();
    expect(parseBudgetValue("")).toBeUndefined();
  });
});
