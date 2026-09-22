import { describe, expect, it } from "vitest";
import { createSanitizedProviderError, sanitizeProviderErrorText } from "../provider-error-record.js";

describe("provider error diagnostics", () => {
  it("preserves allowlisted transport codes through wrappers and cyclic causes without leaking payloads", () => {
    const socket = Object.assign(new Error("other side closed; secret credential"), { code: "UND_ERR_SOCKET" });
    const terminated = new TypeError("terminated", { cause: socket });
    const wrapper = Object.assign(new Error("opaque private prompt", { cause: terminated }), { code: "private-code" });
    socket.cause = wrapper;
    const record = createSanitizedProviderError(wrapper, {
      providerId: "openai", modelId: "gpt-6-astra", thinkingLevel: "high", messageCount: 1, toolCount: 0,
      retry: { attempt: 1, maxAttempts: 2 },
    });
    expect(record).toMatchObject({ code: "UND_ERR_SOCKET", message: "Provider connection failed.", retry: { attempt: 1, maxAttempts: 2 } });
    expect(JSON.stringify(record)).not.toMatch(/secret credential|private prompt|private-code|stack/);
  });
  it("keeps allowlisted validation fields without serializing request internals", () => {
    const error = Object.assign(
      new Error("Invalid parameter reasoning_effort; Authorization: Bearer secret-token-value-1234567890"),
      {
        status: 400,
        code: "InvalidParameter",
        param: "reasoning_effort",
        headers: { authorization: "Bearer must-never-be-saved" },
        request: { messages: [{ role: "user", content: "private prompt" }] },
      },
    );

    const record = createSanitizedProviderError(error, {
      providerId: "zhipuai-coding-plan",
      modelId: "glm-5.3",
      model: "zhipuai-coding-plan:glm-5.3",
      thinkingLevel: "max",
      messageCount: 17,
      toolCount: 12,
    });
    const serialized = JSON.stringify(record);

    expect(record).toMatchObject({
      providerId: "zhipuai-coding-plan",
      modelId: "glm-5.3",
      thinkingLevel: "max",
      name: "ProviderError",
      httpStatus: 400,
      code: "invalid_parameter",
      parameter: "reasoning_effort",
      messageCount: 17,
      toolCount: 12,
    });
    expect(record.message).toBe("Provider rejected a request parameter.");
    expect(serialized).not.toContain("secret-token-value");
    expect(serialized).not.toContain("must-never-be-saved");
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("headers");
    expect(serialized).not.toContain('"request"');
    expect(serialized).not.toContain("stack");
  });

  it("never copies unknown credentials or request content into its fixed summary", () => {
    const opaque = "opaqueCredentialValue12345678901234567890";
    const inputs = [
      `API key provided: ${opaque}`,
      `x-api-key: ${opaque}`,
      `400 invalid parameter; request={\\"messages\\":[{\\"content\\":\\"private text ${opaque}\\"}]}`,
    ];

    for (const input of inputs) {
      const result = sanitizeProviderErrorText(input);
      expect(result).not.toContain(opaque);
      expect(result).not.toContain("private text");
      expect([
        "Provider request failed.",
        "Provider rejected a request parameter.",
      ]).toContain(result);
    }
  });

  it("keeps the geogate diagnosis as a safe, locally-authored category", () => {
    expect(sanitizeProviderErrorText("User location is not supported for the API use."))
      .toBe("User location is not supported for API use.");
  });

  it("drops opaque values from nominal identifier fields", () => {
    const opaque = "opaqueCredentialValue12345678901234567890";
    const error = Object.assign(new Error("failed"), {
      name: opaque,
      code: opaque,
      param: opaque,
    });
    const record = createSanitizedProviderError(error, {
      providerId: "google",
      modelId: "gemini-3.8-flash",
      thinkingLevel: "off",
      messageCount: 1,
      toolCount: 0,
    });

    expect(record.name).toBe("ProviderError");
    expect(record.code).toBeUndefined();
    expect(record.parameter).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain(opaque);
  });
});
