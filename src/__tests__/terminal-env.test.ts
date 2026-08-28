import { describe, expect, it } from "vitest";
import { isMultiplexedTerminal } from "../tui/model/terminal-env.js";

describe("isMultiplexedTerminal", () => {
  it("detects tmux via TMUX and TERM", () => {
    expect(isMultiplexedTerminal({ TMUX: "/tmp/tmux-501/default,1,0" })).toBe(true);
    expect(isMultiplexedTerminal({ TERM: "tmux-256color" })).toBe(true);
    expect(isMultiplexedTerminal({ TERM: "tmux" })).toBe(true);
  });

  it("detects GNU screen via STY and TERM", () => {
    expect(isMultiplexedTerminal({ STY: "1234.pts-0.host" })).toBe(true);
    expect(isMultiplexedTerminal({ TERM: "screen-256color" })).toBe(true);
    expect(isMultiplexedTerminal({ TERM: "screen.xterm" })).toBe(true);
  });

  it("returns false for plain terminals (the no-flash fast path)", () => {
    expect(isMultiplexedTerminal({ TERM: "xterm-256color" })).toBe(false);
    expect(isMultiplexedTerminal({ TERM: "" })).toBe(false);
    expect(isMultiplexedTerminal({})).toBe(false);
    // Substring, not prefix: must not false-positive on "...screen..." in TERM.
    expect(isMultiplexedTerminal({ TERM: "fooscreen" })).toBe(false);
  });
});
