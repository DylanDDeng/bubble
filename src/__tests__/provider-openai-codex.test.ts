import { describe, expect, it } from "vitest";
import { extractChatGptAccountId, getOpenAICodexFallbackModels, isOpenAICodexBaseUrl } from "../provider-openai-codex.js";

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
});
