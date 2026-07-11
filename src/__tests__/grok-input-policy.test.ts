import { describe, expect, it } from "vitest";
import {
  classifyGrokInput,
  grokSlashCommandName,
  isGrokLocalSlashCommand,
} from "../external-runtime/grok-input-policy.js";

describe("Grok workspace input policy", () => {
  it("accepts ordinary prompts", () => {
    expect(classifyGrokInput({ text: "explain this idea\nwithout reading my files", imageCount: 0 }))
      .toEqual({ kind: "prompt" });
  });

  it.each(["help", "theme", "session", "model", "provider", "login", "feedback", "quit", "exit"])(
    "keeps /%s local",
    (command) => {
      expect(isGrokLocalSlashCommand(command)).toBe(true);
      expect(classifyGrokInput({ text: `/${command}`, imageCount: 0 }))
        .toMatchObject({ kind: "local_command", command });
    },
  );

  it("only allows Grok logout in an active Grok session", () => {
    expect(classifyGrokInput({ text: "/logout grok", imageCount: 0 }))
      .toMatchObject({ kind: "local_command", command: "logout" });
    expect(classifyGrokInput({ text: "/logout", imageCount: 0 }))
      .toMatchObject({ kind: "blocked" });
    expect(classifyGrokInput({ text: "/logout openai", imageCount: 0 }))
      .toMatchObject({ kind: "blocked" });
  });

  it.each(["/goal ship it", "/compact", "/memory", "/mcp", "/agents", "/permissions", "/some-skill"])(
    "blocks non-local runtime command %s",
    (text) => {
      expect(classifyGrokInput({ text, imageCount: 0 })).toMatchObject({ kind: "blocked" });
    },
  );

  it("blocks an incomplete slash command", () => {
    expect(classifyGrokInput({ text: "/", imageCount: 0 })).toMatchObject({ kind: "blocked" });
  });

  it("blocks unsupported images but allows workspace file mentions", () => {
    expect(classifyGrokInput({ text: "describe", imageCount: 1 })).toMatchObject({ kind: "blocked" });
    expect(classifyGrokInput({ text: "look at @src/main.ts", imageCount: 0 })).toEqual({ kind: "prompt" });
    expect(classifyGrokInput({ text: "mail user@example.com", imageCount: 0 })).toEqual({ kind: "prompt" });
  });

  it("normalizes slash command names", () => {
    expect(grokSlashCommandName("  /MODEL gpt-5")).toBe("model");
  });
});
