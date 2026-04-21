import { describe, expect, it } from "vitest";
import {
  isImageFilePath,
  isScreenshotTempPath,
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
