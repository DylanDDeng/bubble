import { describe, expect, it } from "vitest";
import { parseArgs } from "../cli.js";

describe("parseArgs", () => {
  it("does not expose no-session anymore", () => {
    const args = parseArgs(["--no-session"]);
    expect("noSession" in args).toBe(false);
  });

  it("parses resume and session flags", () => {
    const args = parseArgs(["--resume", "--session", "named.jsonl"]);
    expect(args.resume).toBe(true);
    expect(args.sessionName).toBe("named.jsonl");
  });
});
