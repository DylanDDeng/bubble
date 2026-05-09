import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildImageContentPartsFromLabels,
  buildImageContentParts,
  extractImagePathTokens,
  formatImageDisplayInput,
  isImageFilePath,
  isScreenshotTempPath,
  removeImagePathTokens,
  resolveComposerImagePaths,
  resolveImageInput,
  splitPastedPaths,
} from "../tui/image-paste.js";

describe("isImageFilePath", () => {
  it("accepts absolute image paths", () => {
    expect(isImageFilePath("/Users/me/Desktop/shot.png")).toBe(true);
    expect(isImageFilePath("/tmp/a.JPEG")).toBe(true);
    expect(isImageFilePath("~/Pictures/x.webp")).toBe(true);
    expect(isImageFilePath("C:\\Users\\me\\a.gif")).toBe(true);
  });

  it("rejects bare filenames and non-image extensions", () => {
    expect(isImageFilePath("shot.png")).toBe(false);
    expect(isImageFilePath("/tmp/a.txt")).toBe(false);
    expect(isImageFilePath("/tmp/a")).toBe(false);
    expect(isImageFilePath("")).toBe(false);
  });
});

describe("splitPastedPaths", () => {
  it("splits newline-separated paths", () => {
    expect(splitPastedPaths("/tmp/a.png\n/tmp/b.png")).toEqual([
      "/tmp/a.png",
      "/tmp/b.png",
    ]);
  });

  it("splits space-separated absolute paths without breaking paths that contain escaped spaces", () => {
    // Finder drags deliver paths with spaces escaped as "\ ".
    const pasted = "/tmp/one.png /Users/me/has\\ space.png /tmp/three.png";
    expect(splitPastedPaths(pasted)).toEqual([
      "/tmp/one.png",
      "/Users/me/has\\ space.png",
      "/tmp/three.png",
    ]);
  });

  it("handles Windows drive-letter paths", () => {
    expect(splitPastedPaths("C:\\a.png D:\\sub\\b.png")).toEqual([
      "C:\\a.png",
      "D:\\sub\\b.png",
    ]);
  });

  it("returns a single entry for plain text", () => {
    expect(splitPastedPaths("hello world")).toEqual(["hello world"]);
  });
});

describe("extractImagePathTokens", () => {
  it("finds image paths mixed with prompt text", () => {
    const input = "review /tmp/one.png and \"/Users/me/My Shot.jpg\" please";
    expect(extractImagePathTokens(input).map((token) => token.rawPath)).toEqual([
      "/tmp/one.png",
      "/Users/me/My Shot.jpg",
    ]);
  });

  it("keeps escaped spaces inside dragged Finder paths", () => {
    const input = "/Users/me/My\\ Shot.png explain this";
    const tokens = extractImagePathTokens(input);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.rawPath).toBe("/Users/me/My\\ Shot.png");
  });
});

describe("removeImagePathTokens", () => {
  it("removes image paths while preserving the user question", () => {
    const input = "/tmp/one.png what is wrong with /tmp/two.jpg here?";
    expect(removeImagePathTokens(input, extractImagePathTokens(input))).toBe("what is wrong with here?");
  });
});

describe("image message formatting", () => {
  const attachment = {
    base64: "aGVsbG8=",
    mediaType: "image/png",
    bytes: 5,
    dataUrl: "data:image/png;base64,aGVsbG8=",
    filename: "shot.png",
  };

  it("builds ContentPart arrays for model input", () => {
    expect(buildImageContentParts("describe it", [attachment])).toEqual([
      { type: "text", text: "describe it" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
    ]);
  });

  it("formats display input without leaking base64", () => {
    expect(formatImageDisplayInput("describe it", [attachment])).toBe("describe it\n[image#1.png]");
  });

  it("continues image labels from a caller-provided session index", () => {
    expect(formatImageDisplayInput("describe it", [attachment, { ...attachment, mediaType: "image/jpeg", filename: "next.jpg" }], 3))
      .toBe("describe it\n[image#3.png]\n[image#4.jpg]");
  });

  it("builds ContentPart arrays from composer labels", () => {
    const attachments = new Map([
      ["image#1.png", attachment],
      ["image#3.jpg", { ...attachment, mediaType: "image/jpeg", filename: "next.jpg", dataUrl: "data:image/jpeg;base64,abc" }],
    ]);

    expect(buildImageContentPartsFromLabels("compare [image#1.png] with [image#3.jpg]", attachments)).toEqual({
      actualInput: [
        { type: "text", text: "compare" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
        { type: "text", text: "with" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc" } },
      ],
      displayInput: "compare [image#1.png] with [image#3.jpg]",
      usedLabels: ["image#1.png", "image#3.jpg"],
    });
  });

  it("preserves image-first composer label order", () => {
    const attachments = new Map([["image#1.png", attachment]]);

    expect(buildImageContentPartsFromLabels("[image#1.png] what is this?", attachments)).toEqual({
      actualInput: [
        { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
        { type: "text", text: "what is this?" },
      ],
      displayInput: "[image#1.png] what is this?",
      usedLabels: ["image#1.png"],
    });
  });

  it("ignores deleted or missing image labels", () => {
    const attachments = new Map([["image#2.png", attachment]]);

    expect(buildImageContentPartsFromLabels("describe [image#1.png]", attachments)).toEqual({
      displayInput: "describe [image#1.png]",
      usedLabels: [],
    });
  });
});

describe("resolveImageInput", () => {
  it("turns dragged image paths into image content parts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bubble image "));
    const imagePath = path.join(dir, "screen shot.png");
    await fs.writeFile(imagePath, Buffer.from("fake-png"));
    const draggedPath = imagePath.replace(/ /g, "\\ ");

    const result = await resolveImageInput(`${draggedPath} what changed?`);

    expect(result.errors).toEqual([]);
    expect(result.displayInput).toBe("[image#1.png] what changed?");
    expect(result.actualInput).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,ZmFrZS1wbmc=" } },
      { type: "text", text: "what changed?" },
    ]);
  });

  it("adds a default prompt when the user only provides images", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bubble image "));
    const imagePath = path.join(dir, "only.png");
    await fs.writeFile(imagePath, Buffer.from("fake-png"));
    const draggedPath = imagePath.replace(/ /g, "\\ ");

    const result = await resolveImageInput(draggedPath, { labelStart: 7 });

    expect(result.displayInput).toBe("[image#7.png]");
    expect(Array.isArray(result.actualInput) ? result.actualInput[0] : undefined).toEqual({
      type: "text",
      text: "Please analyze the attached image.",
    });
  });

  it("reports recognized but unreadable image paths without requiring slash handling", async () => {
    const result = await resolveImageInput("/tmp/does-not-exist.png");

    expect(result.imagePathCount).toBe(1);
    expect(result.attachments).toEqual([]);
    expect(result.errors[0]).toContain("/tmp/does-not-exist.png");
    expect(result.actualInput).toBe("/tmp/does-not-exist.png");
  });
});

describe("resolveComposerImagePaths", () => {
  it("replaces pasted image paths with stable composer labels", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bubble image "));
    const first = path.join(dir, "first.png");
    const second = path.join(dir, "second.jpg");
    await fs.writeFile(first, Buffer.from("first"));
    await fs.writeFile(second, Buffer.from("second"));

    const result = await resolveComposerImagePaths(
      `${first.replace(/ /g, "\\ ")} compare ${second.replace(/ /g, "\\ ")}`,
      { labelStart: 4 },
    );

    expect(result.text).toBe("[image#4.png] compare [image#5.jpg]");
    expect(result.attachments.map((attachment) => attachment.label)).toEqual(["image#4.png", "image#5.jpg"]);
    expect(result.nextLabelIndex).toBe(6);
  });
});

describe("isScreenshotTempPath", () => {
  it("matches macOS screencaptureui temp paths", () => {
    expect(
      isScreenshotTempPath(
        "/private/var/folders/x/TemporaryItems/NSIRD_screencaptureui_abc/Screenshot 2025-01-01.png",
      ),
    ).toBe(true);
  });

  it("does not match unrelated paths", () => {
    expect(isScreenshotTempPath("/tmp/shot.png")).toBe(false);
  });
});
