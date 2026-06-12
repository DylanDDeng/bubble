import { describe, expect, it } from "vitest";
import {
  bareImageFilenameFromPaste,
  extractImagePathTokens,
  imageLabelForPath,
  isImagePathPaste,
} from "../tui/image-paste.js";

const TEMP_PATH = "/var/folders/kj/T/TemporaryItems/NSIRD_screencaptureui_abc/Screenshot.png";

describe("isImagePathPaste", () => {
  it("accepts a single absolute image path", () => {
    expect(isImagePathPaste(TEMP_PATH)).toBe(true);
    expect(isImagePathPaste(`${TEMP_PATH}\n`)).toBe(true);
    expect(isImagePathPaste("~/Desktop/photo.jpeg")).toBe(true);
    expect(isImagePathPaste("C:\\Users\\me\\pic.webp")).toBe(true);
  });

  it("accepts multiple paths from a Finder multi-drag", () => {
    expect(isImagePathPaste(`${TEMP_PATH} /tmp/other.png`)).toBe(true);
    expect(isImagePathPaste(`${TEMP_PATH}\n/tmp/other.png`)).toBe(true);
  });

  it("rejects ordinary text, URLs, and non-image paths", () => {
    expect(isImagePathPaste("")).toBe(false);
    expect(isImagePathPaste("hello world")).toBe(false);
    expect(isImagePathPaste("https://example.com/foo.png")).toBe(false);
    expect(isImagePathPaste("/tmp/notes.txt")).toBe(false);
    expect(isImagePathPaste(`look at ${TEMP_PATH}`)).toBe(false);
  });
});

describe("bareImageFilenameFromPaste", () => {
  it("accepts a directory-less image filename, spaces included", () => {
    expect(bareImageFilenameFromPaste("Screenshot 2026-06-12 at 9.41.18 AM.png")).toBe(
      "Screenshot 2026-06-12 at 9.41.18 AM.png",
    );
    expect(bareImageFilenameFromPaste("微信图片_20260612.jpg\n")).toBe("微信图片_20260612.jpg");
  });

  it("rejects paths, multi-line blobs, and non-image names", () => {
    expect(bareImageFilenameFromPaste("/tmp/test.png")).toBeNull();
    expect(bareImageFilenameFromPaste("C:\\pics\\test.png")).toBeNull();
    expect(bareImageFilenameFromPaste("a.png\nb.png")).toBeNull();
    expect(bareImageFilenameFromPaste("notes.txt")).toBeNull();
    expect(bareImageFilenameFromPaste("")).toBeNull();
    expect(bareImageFilenameFromPaste(`${"x".repeat(256)}.png`)).toBeNull();
  });
});

describe("imageLabelForPath", () => {
  it("derives the label extension from the path without touching the file", () => {
    expect(imageLabelForPath(TEMP_PATH, 1)).toBe("image#1.png");
    expect(imageLabelForPath("~/Desktop/Photo.JPEG", 3)).toBe("image#3.jpeg");
    expect(imageLabelForPath("/tmp/with\\ space.png", 2)).toBe("image#2.png");
  });
});

describe("extractImagePathTokens boundary", () => {
  it("matches a path at the start or after whitespace, but not glued to text", () => {
    expect(extractImagePathTokens(TEMP_PATH)).toHaveLength(1);
    expect(extractImagePathTokens(`look at this ${TEMP_PATH}`)).toHaveLength(1);
    // Glued paths are why handleComposerPaste pads image-path pastes.
    expect(extractImagePathTokens(`帮我看看这个图${TEMP_PATH}`)).toHaveLength(0);
  });
});
