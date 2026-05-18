import { describe, expect, it } from "vitest";
import {
  extractChatGptAccountId,
  getOpenAICodexFallbackModels,
  isOpenAICodexBaseUrl,
  sortCodexModelDescriptors,
} from "../provider-openai-codex.js";

function encodePayload(payload: object): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
}

describe("provider-openai-codex", () => {
  it("recognizes the ChatGPT Codex backend base URL", () => {
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://api.openai.com/v1")).toBe(false);
  });

  it("extracts the chatgpt account id from the access token", () => {
    const token = `header.${encodePayload({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-123",
      },
    })}.sig`;

    expect(extractChatGptAccountId(token)).toBe("account-123");
  });

  it("returns the latest fallback model first", () => {
    expect(getOpenAICodexFallbackModels()[0]).toBe("gpt-5.4");
  });

  it("sorts models by family version desc, floating new families above catalog entries", () => {
    // shuffled input; gpt-5.5 isn't in the static catalog yet
    const sorted = sortCodexModelDescriptors([
      { id: "gpt-5.4-mini" },
      { id: "gpt-5.2" },
      { id: "gpt-5.4" },
      { id: "gpt-5.5" },
      { id: "gpt-5.3-codex" },
    ]).map((d) => d.id);

    expect(sorted[0]).toBe("gpt-5.5");
    expect(sorted.indexOf("gpt-5.4")).toBeLessThan(sorted.indexOf("gpt-5.4-mini"));
    expect(sorted.indexOf("gpt-5.4-mini")).toBeLessThan(sorted.indexOf("gpt-5.3-codex"));
    expect(sorted[sorted.length - 1]).toBe("gpt-5.2");
  });
});
