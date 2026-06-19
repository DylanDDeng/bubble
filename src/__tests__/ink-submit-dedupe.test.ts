import { describe, expect, it } from "vitest";
import type { SubmitPayload } from "../tui-ink/input-box.js";
import {
  decideStartingSubmit,
  decideStartingSubmitFingerprint,
  submitPayloadFingerprint,
} from "../tui-ink/submit-dedupe.js";

function payload(text: string, displayText?: string): SubmitPayload {
  return { text, displayText, images: [] };
}

describe("Ink submit dedupe", () => {
  it("accepts the first submit while no run is starting", () => {
    expect(decideStartingSubmit(null, payload("hello"))).toBe("accept");
  });

  it("ignores the same payload while the first submit is still starting", () => {
    const first = payload("hello");
    const fingerprint = submitPayloadFingerprint(first);

    expect(decideStartingSubmitFingerprint(fingerprint, submitPayloadFingerprint(first))).toBe("ignore");
  });

  it("queues a different payload while another submit is still starting", () => {
    const fingerprint = submitPayloadFingerprint(payload("hello"));

    expect(decideStartingSubmitFingerprint(fingerprint, submitPayloadFingerprint(payload("hello again")))).toBe("queue");
  });

  it("includes display text and image content in the fingerprint", () => {
    const expanded = payload("expanded file content", "@file.md");
    const sameTextDifferentDisplay = payload("expanded file content");
    const withImageA: SubmitPayload = {
      text: "look",
      images: [{
        base64: "aaaa",
        mediaType: "image/png",
        bytes: 3,
        dataUrl: "data:image/png;base64,aaaa",
        filename: "shot.png",
      }],
    };
    const withImageB: SubmitPayload = {
      text: "look",
      images: [{
        base64: "bbbb",
        mediaType: "image/png",
        bytes: 3,
        dataUrl: "data:image/png;base64,bbbb",
        filename: "shot.png",
      }],
    };

    expect(submitPayloadFingerprint(expanded)).not.toBe(submitPayloadFingerprint(sameTextDifferentDisplay));
    expect(submitPayloadFingerprint(withImageA)).not.toBe(submitPayloadFingerprint(withImageB));
  });
});
