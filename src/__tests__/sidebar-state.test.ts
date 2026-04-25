import { describe, expect, it } from "vitest";
import { mergeFileChanges, parseGitNumstat } from "../tui/sidebar-state.js";

describe("sidebar git state helpers", () => {
  it("parses git numstat output", () => {
    expect(parseGitNumstat("10\t2\tsrc/app.ts\n-\t-\tassets/logo.png\n")).toEqual([
      { file: "src/app.ts", additions: 10, deletions: 2 },
      { file: "assets/logo.png", additions: 0, deletions: 0 },
    ]);
  });

  it("merges staged and unstaged file changes", () => {
    expect(mergeFileChanges(
      [{ file: "src/app.ts", additions: 3, deletions: 1 }],
      [
        { file: "README.md", additions: 4, deletions: 0 },
        { file: "src/app.ts", additions: 2, deletions: 5 },
      ],
    )).toEqual([
      { file: "README.md", additions: 4, deletions: 0 },
      { file: "src/app.ts", additions: 5, deletions: 6 },
    ]);
  });

  it("keeps untracked files in the merged list", () => {
    expect(mergeFileChanges(
      [{ file: "src/app.ts", additions: 3, deletions: 1 }],
      [{ file: "src/new.ts", additions: 0, deletions: 0 }],
    )).toEqual([
      { file: "src/app.ts", additions: 3, deletions: 1 },
      { file: "src/new.ts", additions: 0, deletions: 0 },
    ]);
  });
});
