import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import { ingestClipboardImage } from "../tui/model/image-paste.js";

describe("macOS clipboard image ingestion", () => {
  let platformSpy: ReturnType<typeof vi.spyOn>;
  const writtenPaths: string[] = [];

  beforeEach(() => {
    platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    execFileMock.mockReset();
    execFileMock.mockImplementation((
      _file: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      const script = args.at(-1) ?? "";
      if (script === "the clipboard as «class PNGf»") {
        const error = new RangeError("stdout maxBuffer length exceeded") as RangeError & { code?: string };
        error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        callback(error);
        return;
      }
      if (script.includes("clipboard info for «class furl»")) {
        callback(null, "", "");
        return;
      }
      const match = script.match(/POSIX file \"([^\"]+)\"/);
      if (!match) {
        callback(new Error("missing temporary output path"));
        return;
      }
      const outputPath = match[1]!;
      writtenPaths.push(outputPath);
      fs.writeFileSync(outputPath, Buffer.alloc(900 * 1024, 1));
      callback(null, "", "");
    });
  });

  afterEach(() => {
    platformSpy.mockRestore();
    for (const outputPath of writtenPaths.splice(0)) {
      fs.rmSync(outputPath, { force: true });
    }
  });

  it("writes a large PNG directly to disk without capturing it on stdout", async () => {
    const result = await ingestClipboardImage();

    expect(result.error).toBeUndefined();
    expect(result.attachment).toMatchObject({
      mediaType: "image/png",
      bytes: 900 * 1024,
    });
    expect(execFileMock.mock.calls.some((call) => call[1]?.[1] === "the clipboard as «class PNGf»"))
      .toBe(false);
  });
});
