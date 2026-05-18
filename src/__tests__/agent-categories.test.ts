import { describe, expect, it } from "vitest";
import {
  mergeAgentCategories,
  resolveModelRoute,
  resolveSameProviderModelRoute,
  resolveSubagentRoute,
  sanitizeAgentCategories,
} from "../agent/categories.js";

describe("agent categories", () => {
  const parent = {
    providerId: "openai",
    model: "gpt-4o",
    thinkingLevel: "medium" as const,
  };

  it("merges built-in categories with sanitized user overrides", () => {
    const categories = mergeAgentCategories({
      deep: { model: "gpt-5.4", thinkingLevel: "xhigh", maxConcurrent: 4 },
      ignored: { model: "", thinkingLevel: "invalid" as any, maxConcurrent: -1 },
    });

    expect(categories.quick?.model).toBe("inherit");
    expect(categories.deep).toEqual({ model: "gpt-5.4", thinkingLevel: "xhigh", maxConcurrent: 4 });
    expect(categories.ignored).toEqual({ maxConcurrent: 1 });
  });

  it("merges user category overrides field-by-field over built-ins", () => {
    const categories = mergeAgentCategories({
      deep: { model: "gpt-5.4" },
    });

    expect(categories.deep).toEqual({ model: "gpt-5.4", thinkingLevel: "high", maxConcurrent: 2 });
  });

  it("sanitizes category config from unknown input", () => {
    expect(sanitizeAgentCategories(null)).toEqual({});
    expect(sanitizeAgentCategories({
      Review: { model: " openai:gpt-5.4 ", thinkingLevel: "high", maxConcurrent: 2.8 },
      bad: "nope",
    })).toEqual({
      review: { model: "openai:gpt-5.4", thinkingLevel: "high", maxConcurrent: 2 },
    });
  });

  it("resolves same-provider category routes and inherits parent route by default", () => {
    expect(resolveSubagentRoute(undefined, parent)).toEqual({
      route: { ...parent, inherited: true },
    });

    expect(resolveSubagentRoute("review", parent, {
      review: { model: "gpt-5.4", thinkingLevel: "high" },
    })).toEqual({
      route: {
        category: "review",
        providerId: "openai",
        model: "gpt-5.4",
        thinkingLevel: "high",
        inherited: false,
      },
    });
  });

  it("resolves cross-provider category and profile model routes for the provider factory", () => {
    expect(resolveSubagentRoute("review", parent, {
      review: { model: "anthropic:claude-sonnet-4.5" },
    })).toEqual({
      route: {
        category: "review",
        providerId: "anthropic",
        model: "claude-sonnet-4.5",
        thinkingLevel: "high",
        inherited: false,
      },
    });

    expect(resolveModelRoute("anthropic:claude-sonnet-4.5", parent.providerId)).toEqual({
      providerId: "anthropic",
      model: "claude-sonnet-4.5",
    });
    expect(resolveSameProviderModelRoute("anthropic:claude-sonnet-4.5", parent.providerId)).toEqual({
      model: "claude-sonnet-4.5",
    });
  });
});
