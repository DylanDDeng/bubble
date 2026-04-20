import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRuleSet,
  checkPermission,
  matchRule,
  parseRule,
  parseRules,
} from "../permissions/rule.js";

describe("parseRule", () => {
  it("parses a bare tool name", () => {
    const r = parseRule("Bash");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rule.tool).toBe("Bash");
      expect(r.rule.pattern).toBeUndefined();
    }
  });

  it("parses a tool with pattern", () => {
    const r = parseRule("Bash(git status)");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rule.tool).toBe("Bash");
      expect(r.rule.pattern).toBe("git status");
    }
  });

  it("parses the wildcard tool", () => {
    const r = parseRule("*");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rule.tool).toBe("*");
  });

  it("rejects empty parens", () => {
    const r = parseRule("Bash()");
    expect(r.ok).toBe(false);
  });

  it("rejects malformed input", () => {
    expect(parseRule("").ok).toBe(false);
    expect(parseRule("Bash(unterminated").ok).toBe(false);
    expect(parseRule("Bash(a)(b)").ok).toBe(false);
  });

  it("preserves source text for diagnostics", () => {
    const r = parseRule("  Bash(git status)  ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rule.source).toBe("  Bash(git status)  ");
  });

  it("batches parse results with errors", () => {
    const { rules, errors } = parseRules(["Bash", "Bash()", "Read(./src/**)"]);
    expect(rules).toHaveLength(2);
    expect(errors).toHaveLength(1);
  });
});

describe("matchRule — Bash", () => {
  const rule = (s: string) => {
    const p = parseRule(s);
    if (!p.ok) throw new Error(`bad rule: ${p.error.message}`);
    return p.rule;
  };

  it("bare Bash matches any command", () => {
    expect(matchRule(rule("Bash"), { tool: "Bash", command: "anything goes" })).toBe(true);
  });

  it("exact match requires full token equality", () => {
    expect(matchRule(rule("Bash(git status)"), { tool: "Bash", command: "git status" })).toBe(true);
    expect(matchRule(rule("Bash(git status)"), { tool: "Bash", command: "git status --short" })).toBe(false);
    expect(matchRule(rule("Bash(git status)"), { tool: "Bash", command: "git" })).toBe(false);
  });

  it("normalizes whitespace in exact match", () => {
    expect(matchRule(rule("Bash(git  status)"), { tool: "Bash", command: "git status" })).toBe(true);
    expect(matchRule(rule("Bash(git status)"), { tool: "Bash", command: "  git   status  " })).toBe(true);
  });

  it("prefix match with :*", () => {
    const r = rule("Bash(npm run:*)");
    expect(matchRule(r, { tool: "Bash", command: "npm run test" })).toBe(true);
    expect(matchRule(r, { tool: "Bash", command: "npm run build --watch" })).toBe(true);
    expect(matchRule(r, { tool: "Bash", command: "npm run" })).toBe(true);
    expect(matchRule(r, { tool: "Bash", command: "npm install" })).toBe(false);
  });

  it("prefix match when :* sits as its own token", () => {
    const r = rule("Bash(git :*)");
    expect(matchRule(r, { tool: "Bash", command: "git status" })).toBe(true);
    expect(matchRule(r, { tool: "Bash", command: "gh status" })).toBe(false);
  });

  it("does not cross-match tools", () => {
    expect(matchRule(rule("Bash(ls)"), { tool: "Read", path: "ls", cwd: "/tmp" })).toBe(false);
  });
});

describe("matchRule — Read/Write/Edit paths", () => {
  const rule = (s: string) => {
    const p = parseRule(s);
    if (!p.ok) throw new Error(p.error.message);
    return p.rule;
  };

  it("matches absolute glob", () => {
    expect(
      matchRule(rule("Read(/tmp/foo/**)"), {
        tool: "Read",
        path: "/tmp/foo/bar.txt",
        cwd: "/elsewhere",
      }),
    ).toBe(true);
  });

  it("resolves cwd-relative globs", () => {
    expect(
      matchRule(rule("Read(./src/**)"), {
        tool: "Read",
        path: resolve("/work/project/src/index.ts"),
        cwd: "/work/project",
      }),
    ).toBe(true);

    expect(
      matchRule(rule("Read(./src/**)"), {
        tool: "Read",
        path: resolve("/work/project/test/foo.ts"),
        cwd: "/work/project",
      }),
    ).toBe(false);
  });

  it("expands ~ to home", () => {
    expect(
      matchRule(rule("Read(~/.ssh/**)"), {
        tool: "Read",
        path: resolve(homedir(), ".ssh/id_rsa"),
        cwd: "/anywhere",
      }),
    ).toBe(true);
  });

  it("applies independently to Write and Edit", () => {
    const r = rule("Write(/etc/**)");
    expect(matchRule(r, { tool: "Write", path: "/etc/hosts", cwd: "/x" })).toBe(true);
    expect(matchRule(r, { tool: "Edit", path: "/etc/hosts", cwd: "/x" })).toBe(false);
    expect(matchRule(r, { tool: "Read", path: "/etc/hosts", cwd: "/x" })).toBe(false);
  });
});

describe("matchRule — WebFetch domain", () => {
  const rule = (s: string) => {
    const p = parseRule(s);
    if (!p.ok) throw new Error(p.error.message);
    return p.rule;
  };

  it("matches exact host", () => {
    expect(
      matchRule(rule("WebFetch(domain:github.com)"), {
        tool: "WebFetch",
        url: "https://github.com/anthropics/anthropic-sdk-python",
      }),
    ).toBe(true);
  });

  it("matches subdomains", () => {
    expect(
      matchRule(rule("WebFetch(domain:github.com)"), {
        tool: "WebFetch",
        url: "https://api.github.com/repos",
      }),
    ).toBe(true);
  });

  it("does not match unrelated hosts", () => {
    expect(
      matchRule(rule("WebFetch(domain:github.com)"), {
        tool: "WebFetch",
        url: "https://notgithub.com/",
      }),
    ).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(
      matchRule(rule("WebFetch(domain:github.com)"), {
        tool: "WebFetch",
        url: "not a url",
      }),
    ).toBe(false);
  });

  it("bare WebFetch matches any URL", () => {
    expect(
      matchRule(rule("WebFetch"), { tool: "WebFetch", url: "https://example.com/" }),
    ).toBe(true);
  });
});

describe("matchRule — WebSearch and wildcard", () => {
  it("WebSearch bare rule matches any search", () => {
    const p = parseRule("WebSearch");
    if (!p.ok) throw new Error("bad rule");
    expect(matchRule(p.rule, { tool: "WebSearch" })).toBe(true);
  });

  it("* matches any tool", () => {
    const p = parseRule("*");
    if (!p.ok) throw new Error("bad rule");
    expect(matchRule(p.rule, { tool: "Bash", command: "ls" })).toBe(true);
    expect(matchRule(p.rule, { tool: "WebSearch" })).toBe(true);
  });
});

describe("checkPermission", () => {
  it("returns ask when no rule matches", () => {
    const rules = buildRuleSet([], []);
    expect(checkPermission(rules, { tool: "Bash", command: "ls" }).decision).toBe("ask");
  });

  it("allow rule produces allow", () => {
    const rules = buildRuleSet(["Bash(ls)"], []);
    expect(checkPermission(rules, { tool: "Bash", command: "ls" }).decision).toBe("allow");
  });

  it("deny rule produces deny", () => {
    const rules = buildRuleSet([], ["Bash(rm -rf /)"]);
    expect(checkPermission(rules, { tool: "Bash", command: "rm -rf /" }).decision).toBe("deny");
  });

  it("deny beats allow when both match", () => {
    const rules = buildRuleSet(["Bash"], ["Bash(rm -rf:*)"]);
    const r1 = checkPermission(rules, { tool: "Bash", command: "ls" });
    expect(r1.decision).toBe("allow");

    const r2 = checkPermission(rules, { tool: "Bash", command: "rm -rf /tmp/x" });
    expect(r2.decision).toBe("deny");
  });

  it("wildcard allow lets things through", () => {
    const rules = buildRuleSet(["*"], []);
    expect(checkPermission(rules, { tool: "Bash", command: "anything" }).decision).toBe("allow");
    expect(checkPermission(rules, { tool: "WebSearch" }).decision).toBe("allow");
  });

  it("reports which rule won", () => {
    const rules = buildRuleSet(["Bash(ls)"], []);
    const result = checkPermission(rules, { tool: "Bash", command: "ls" });
    expect(result.rule?.source).toBe("Bash(ls)");
  });
});
