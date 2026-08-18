import { afterEach, describe, expect, it, vi } from "vitest";
import { BEGIN_SYNC, END_SYNC, wrapSynchronizedOutput } from "../tui/model/sync-output.js";

function fakeStream(overrides: Record<string, unknown> = {}): NodeJS.WriteStream {
  return {
    isTTY: true,
    columns: 80,
    rows: 24,
    write: vi.fn(() => true),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  } as unknown as NodeJS.WriteStream;
}

afterEach(() => {
  delete process.env.BUBBLE_NO_SYNC_OUTPUT;
});

describe("synchronized output wrapper", () => {
  it("brackets string frames in begin/end sync sequences", () => {
    const stream = fakeStream();
    const wrapped = wrapSynchronizedOutput(stream);

    const result = wrapped.write("frame content");

    expect(result).toBe(true);
    expect(stream.write).toHaveBeenCalledWith(`${BEGIN_SYNC}frame content${END_SYNC}`);
  });

  it("forwards write callbacks", () => {
    const stream = fakeStream();
    const wrapped = wrapSynchronizedOutput(stream);
    const callback = () => {};

    wrapped.write("x", callback);

    expect(stream.write).toHaveBeenCalledWith(`${BEGIN_SYNC}x${END_SYNC}`, callback);
  });

  it("passes empty strings and buffers through unbracketed", () => {
    const stream = fakeStream();
    const wrapped = wrapSynchronizedOutput(stream);
    const buffer = Buffer.from("binary");

    wrapped.write("");
    wrapped.write(buffer as unknown as string);

    expect(stream.write).toHaveBeenNthCalledWith(1, "");
    expect(stream.write).toHaveBeenNthCalledWith(2, buffer);
  });

  it("proxies non-write members with bound methods", () => {
    const stream = fakeStream();
    const wrapped = wrapSynchronizedOutput(stream);

    expect(wrapped.columns).toBe(80);
    const listener = () => {};
    wrapped.on("resize", listener);
    expect(stream.on).toHaveBeenCalledWith("resize", listener);
  });

  it("returns the raw stream for non-TTY targets", () => {
    const stream = fakeStream({ isTTY: false });
    expect(wrapSynchronizedOutput(stream)).toBe(stream);
  });

  it("honors the BUBBLE_NO_SYNC_OUTPUT escape hatch", () => {
    process.env.BUBBLE_NO_SYNC_OUTPUT = "1";
    const stream = fakeStream();
    expect(wrapSynchronizedOutput(stream)).toBe(stream);
  });
});
