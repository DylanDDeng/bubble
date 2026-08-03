/**
 * 15 verifiable coding tasks. Every scorer is programmatic (subprocess or file
 * assertion) — no LLM judges, so a pass/fail flip between two configs is
 * always a behavior difference, never judge noise.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalTask, TaskScore } from "./types.js";

function write(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content);
}

function read(dir: string, name: string): string {
  return readFileSync(join(dir, name), "utf-8");
}

function runNode(dir: string, args: string[]): { ok: boolean; stdout: string; detail: string } {
  try {
    const stdout = execFileSync(process.execPath, args, {
      cwd: dir,
      timeout: 15_000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, detail: "" };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: err.stdout ?? "",
      detail: (err.stderr || err.message || "").slice(0, 300),
    };
  }
}

function scoreByTest(dir: string, testFile = "test.js"): TaskScore {
  const result = runNode(dir, [testFile]);
  return { pass: result.ok, notes: result.ok ? undefined : result.detail };
}

export const TASKS: EvalTask[] = [
  {
    id: "fix-off-by-one",
    prompt: "test.js fails. Find the bug in sum.js and fix it so the test passes. Do not modify test.js.",
    setup(dir) {
      write(dir, "sum.js", `function sum(values) {\n  let total = 0;\n  for (let i = 0; i < values.length - 1; i++) {\n    total += values[i];\n  }\n  return total;\n}\nmodule.exports = { sum };\n`);
      write(dir, "test.js", `const assert = require("node:assert");\nconst { sum } = require("./sum.js");\nassert.strictEqual(sum([1, 2, 3]), 6);\nassert.strictEqual(sum([]), 0);\nassert.strictEqual(sum([5]), 5);\nconsole.log("ok");\n`);
    },
    score(dir) {
      const score = scoreByTest(dir);
      if (!score.pass) return score;
      const test = read(dir, "test.js");
      if (!test.includes("sum([1, 2, 3]), 6")) return { pass: false, notes: "test.js was modified" };
      return score;
    },
  },
  {
    id: "implement-slugify",
    prompt: "Implement the slugify function in slugify.js according to the spec comment, so test.js passes.",
    setup(dir) {
      write(dir, "slugify.js", `// slugify(title): lowercase, trim, collapse whitespace runs to a single "-",\n// strip every character except a-z, 0-9 and "-", and collapse "-" runs.\nfunction slugify(title) {\n  throw new Error("not implemented");\n}\nmodule.exports = { slugify };\n`);
      write(dir, "test.js", `const assert = require("node:assert");\nconst { slugify } = require("./slugify.js");\nassert.strictEqual(slugify("Hello World"), "hello-world");\nassert.strictEqual(slugify("  Foo   Bar  "), "foo-bar");\nassert.strictEqual(slugify("It's 100% GREAT!"), "its-100-great");\nassert.strictEqual(slugify("a--b"), "a-b");\nconsole.log("ok");\n`);
    },
    score: (dir) => scoreByTest(dir),
  },
  {
    id: "rename-symbol",
    prompt: "Rename the function fetchDataV1 to fetchData across the whole project (definition and every call site). Keep behavior identical.",
    setup(dir) {
      write(dir, "api.js", `async function fetchDataV1(url) {\n  return { url, ok: true };\n}\nmodule.exports = { fetchDataV1 };\n`);
      write(dir, "client.js", `const { fetchDataV1 } = require("./api.js");\nasync function load() {\n  return fetchDataV1("/items");\n}\nmodule.exports = { load };\n`);
      write(dir, "report.js", `const { fetchDataV1 } = require("./api.js");\nasync function report() {\n  const data = await fetchDataV1("/report");\n  return data.ok;\n}\nmodule.exports = { report };\n`);
    },
    score(dir) {
      for (const file of ["api.js", "client.js", "report.js"]) {
        if (read(dir, file).includes("fetchDataV1")) {
          return { pass: false, notes: `${file} still mentions fetchDataV1` };
        }
      }
      const check = runNode(dir, ["-e", `const { load } = require("./client.js"); const { report } = require("./report.js"); Promise.all([load(), report()]).then(([a, b]) => { if (a.url !== "/items" || b !== true) process.exit(1); });`]);
      return { pass: check.ok, notes: check.ok ? undefined : check.detail };
    },
  },
  {
    id: "edit-json-config",
    prompt: "In config.json: bump the minor version (patch resets to 0), add a \"lint\" script running \"eslint src\", and set engines.node to \">=20\". Keep everything else unchanged.",
    setup(dir) {
      write(dir, "config.json", JSON.stringify({
        name: "widget",
        version: "1.4.2",
        scripts: { build: "tsc", test: "vitest run" },
        license: "MIT",
      }, null, 2) + "\n");
    },
    score(dir) {
      try {
        const config = JSON.parse(read(dir, "config.json"));
        if (config.version !== "1.5.0") return { pass: false, notes: `version=${config.version}` };
        if (config.scripts?.lint !== "eslint src") return { pass: false, notes: "lint script wrong" };
        if (config.engines?.node !== ">=20") return { pass: false, notes: "engines.node wrong" };
        if (config.scripts?.build !== "tsc" || config.license !== "MIT") {
          return { pass: false, notes: "unrelated fields changed" };
        }
        return { pass: true };
      } catch (error) {
        return { pass: false, notes: `invalid JSON: ${(error as Error).message}` };
      }
    },
  },
  {
    id: "write-tests",
    prompt: "Write test.js (plain node, using node:assert) covering both mean and median in stats.js. The tests must actually verify median on even-length input. Print \"ok\" and exit 0 on success.",
    setup(dir) {
      write(dir, "stats.js", `function mean(values) {\n  if (values.length === 0) return 0;\n  return values.reduce((a, b) => a + b, 0) / values.length;\n}\nfunction median(values) {\n  if (values.length === 0) return 0;\n  const sorted = [...values].sort((a, b) => a - b);\n  const mid = Math.floor(sorted.length / 2);\n  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];\n}\nmodule.exports = { mean, median };\n`);
    },
    score(dir) {
      const good = scoreByTest(dir);
      if (!good.pass) return { pass: false, notes: `tests fail on correct code: ${good.notes ?? ""}` };
      // Mutation check: a broken median must make the suite fail.
      const original = read(dir, "stats.js");
      write(dir, "stats.js", original.replace("sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 :", "true ?"));
      const mutated = runNode(dir, ["test.js"]);
      write(dir, "stats.js", original);
      return mutated.ok
        ? { pass: false, notes: "tests still pass with median mutated — median not really covered" }
        : { pass: true };
    },
  },
  {
    id: "fix-crash-null",
    prompt: "node main.js crashes. Make it robust: skip malformed entries (missing/nullish price) and print the total for the valid ones. Expected output for the bundled data is \"total: 30\".",
    setup(dir) {
      write(dir, "main.js", `const data = require("./data.json");\nlet total = 0;\nfor (const item of data.items) {\n  total += item.price.amount;\n}\nconsole.log("total: " + total);\n`);
      write(dir, "data.json", JSON.stringify({
        items: [{ price: { amount: 10 } }, { price: null }, {}, { price: { amount: 20 } }],
      }, null, 2));
    },
    score(dir) {
      const result = runNode(dir, ["main.js"]);
      if (!result.ok) return { pass: false, notes: result.detail };
      return result.stdout.trim() === "total: 30"
        ? { pass: true }
        : { pass: false, notes: `stdout=${result.stdout.trim()}` };
    },
  },
  {
    id: "csv-aggregate",
    prompt: "Write aggregate.js: read sales.csv (header row: category,amount), sum amounts per category, and print one \"category,total\" line per category sorted alphabetically by category.",
    setup(dir) {
      write(dir, "sales.csv", "category,amount\nfruit,10\ntools,5\nfruit,7\nbooks,12\ntools,1\n");
    },
    score(dir) {
      const result = runNode(dir, ["aggregate.js"]);
      if (!result.ok) return { pass: false, notes: result.detail };
      const lines = result.stdout.trim().split("\n").map((line) => line.trim());
      const expected = ["books,12", "fruit,17", "tools,6"];
      return JSON.stringify(lines) === JSON.stringify(expected)
        ? { pass: true }
        : { pass: false, notes: `stdout=${JSON.stringify(lines)}` };
    },
  },
  {
    id: "regex-extract-emails",
    prompt: "Write extract.js: read input.txt and print every unique email address found, one per line, sorted alphabetically.",
    setup(dir) {
      write(dir, "input.txt", "Contact ana@example.com or BOB@corp.io.\nDuplicate: ana@example.com\nnoise @ not-an-email\nAlso zoe.lee@test.dev!\n");
    },
    score(dir) {
      const result = runNode(dir, ["extract.js"]);
      if (!result.ok) return { pass: false, notes: result.detail };
      const lines = result.stdout.trim().split("\n").map((line) => line.trim().toLowerCase());
      const expected = ["ana@example.com", "bob@corp.io", "zoe.lee@test.dev"];
      return JSON.stringify(lines) === JSON.stringify(expected)
        ? { pass: true }
        : { pass: false, notes: `stdout=${JSON.stringify(lines)}` };
    },
  },
  {
    id: "refactor-dedupe",
    prompt: "priceMember and priceGuest in lib.js duplicate the discount math. Extract a shared helper named applyDiscount and make both use it. test.js must keep passing; do not modify test.js.",
    setup(dir) {
      write(dir, "lib.js", `function priceMember(base) {\n  const discounted = base - base * 0.2;\n  const taxed = discounted * 1.1;\n  return Math.round(taxed * 100) / 100;\n}\nfunction priceGuest(base) {\n  const discounted = base - base * 0.05;\n  const taxed = discounted * 1.1;\n  return Math.round(taxed * 100) / 100;\n}\nmodule.exports = { priceMember, priceGuest };\n`);
      write(dir, "test.js", `const assert = require("node:assert");\nconst { priceMember, priceGuest } = require("./lib.js");\nassert.strictEqual(priceMember(100), 88);\nassert.strictEqual(priceGuest(100), 104.5);\nconsole.log("ok");\n`);
    },
    score(dir) {
      const score = scoreByTest(dir);
      if (!score.pass) return score;
      const lib = read(dir, "lib.js");
      const mentions = lib.match(/applyDiscount/g)?.length ?? 0;
      if (mentions < 3) return { pass: false, notes: "applyDiscount helper not shared by both paths" };
      return { pass: true };
    },
  },
  {
    id: "respect-constraint",
    prompt: "Change the greeting in app.js from \"Hello\" to \"Welcome\". Important: legacy.js is frozen for compliance reasons — do not modify it in any way, even though it contains the same greeting.",
    setup(dir) {
      write(dir, "app.js", `const { legacyGreet } = require("./legacy.js");\nfunction greet(name) {\n  return "Hello, " + name + "!";\n}\nmodule.exports = { greet, legacyGreet };\n`);
      write(dir, "legacy.js", `// FROZEN FILE — do not edit\nfunction legacyGreet(name) {\n  return "Hello, " + name + "!";\n}\nmodule.exports = { legacyGreet };\n`);
    },
    score(dir) {
      const legacy = read(dir, "legacy.js");
      if (!legacy.includes('return "Hello, " + name + "!";') || !legacy.includes("FROZEN FILE")) {
        return { pass: false, notes: "legacy.js was modified" };
      }
      const check = runNode(dir, ["-e", `const { greet } = require("./app.js"); if (greet("Ann") !== "Welcome, Ann!") process.exit(1);`]);
      return { pass: check.ok, notes: check.ok ? undefined : "greet() does not return Welcome" };
    },
  },
  {
    id: "multi-file-feature",
    prompt: "Add a \"mul\" command to the calculator: node cli.js mul 6 7 must print 42. Register it the same way add/sub are structured (implementation in ops.js, dispatch in cli.js), and mention mul in the usage() text.",
    setup(dir) {
      write(dir, "ops.js", `function add(a, b) { return a + b; }\nfunction sub(a, b) { return a - b; }\nmodule.exports = { add, sub };\n`);
      write(dir, "cli.js", `const ops = require("./ops.js");\nfunction usage() {\n  return "usage: cli.js <add|sub> <a> <b>";\n}\nconst [, , command, a, b] = process.argv;\nconst fn = ops[command];\nif (!fn) {\n  console.error(usage());\n  process.exit(1);\n}\nconsole.log(fn(Number(a), Number(b)));\n`);
    },
    score(dir) {
      const mul = runNode(dir, ["cli.js", "mul", "6", "7"]);
      if (!mul.ok || mul.stdout.trim() !== "42") {
        return { pass: false, notes: `mul 6 7 -> ${mul.ok ? mul.stdout.trim() : mul.detail}` };
      }
      const add = runNode(dir, ["cli.js", "add", "2", "3"]);
      if (!add.ok || add.stdout.trim() !== "5") return { pass: false, notes: "add regressed" };
      if (!read(dir, "ops.js").includes("mul")) return { pass: false, notes: "mul not in ops.js" };
      const bad = runNode(dir, ["cli.js", "nope", "1", "2"]);
      if (bad.ok) return { pass: false, notes: "unknown command no longer errors" };
      if (!bad.detail.includes("mul")) return { pass: false, notes: "usage() does not mention mul" };
      return { pass: true };
    },
  },
  {
    id: "error-messages",
    prompt: "validate() in validator.js returns cryptic codes. Per the table in README.md, make it return the human-readable messages instead, so test.js passes. Do not modify test.js.",
    setup(dir) {
      write(dir, "README.md", `# Validation errors\n\n| code | message |\n|------|---------|\n| E_EMPTY | Name must not be empty |\n| E_LONG | Name must be at most 10 characters |\n| E_CHARS | Name must contain only letters |\n`);
      write(dir, "validator.js", `function validate(name) {\n  if (name.length === 0) return "E_EMPTY";\n  if (name.length > 10) return "E_LONG";\n  if (!/^[A-Za-z]+$/.test(name)) return "E_CHARS";\n  return null;\n}\nmodule.exports = { validate };\n`);
      write(dir, "test.js", `const assert = require("node:assert");\nconst { validate } = require("./validator.js");\nassert.strictEqual(validate(""), "Name must not be empty");\nassert.strictEqual(validate("abcdefghijk"), "Name must be at most 10 characters");\nassert.strictEqual(validate("ab3"), "Name must contain only letters");\nassert.strictEqual(validate("Anna"), null);\nconsole.log("ok");\n`);
    },
    score: (dir) => scoreByTest(dir),
  },
  {
    id: "todo-markdown",
    prompt: "Write count.js: parse todos.md and print exactly two lines — \"open: N\" and \"done: M\" — counting unchecked ([ ]) and checked ([x], case-insensitive) checkbox items.",
    setup(dir) {
      write(dir, "todos.md", "# Todos\n\n- [ ] write report\n- [x] send invoice\n- [X] book flight\n- [ ] call Amy\n- regular bullet, not a checkbox\n- [ ] review PR\n");
    },
    score(dir) {
      const result = runNode(dir, ["count.js"]);
      if (!result.ok) return { pass: false, notes: result.detail };
      const lines = result.stdout.trim().split("\n").map((line) => line.trim());
      return JSON.stringify(lines) === JSON.stringify(["open: 3", "done: 2"])
        ? { pass: true }
        : { pass: false, notes: `stdout=${JSON.stringify(lines)}` };
    },
  },
  {
    id: "fix-async-race",
    prompt: "test.js fails because loadAll in loader.js kicks off async work without awaiting it properly. Fix loader.js so results are complete and ordered; do not modify test.js.",
    setup(dir) {
      write(dir, "loader.js", `async function fetchOne(id) {\n  await new Promise((resolve) => setTimeout(resolve, (5 - id) * 10));\n  return "item-" + id;\n}\nasync function loadAll(ids) {\n  const results = [];\n  ids.forEach(async (id) => {\n    results.push(await fetchOne(id));\n  });\n  return results;\n}\nmodule.exports = { loadAll, fetchOne };\n`);
      write(dir, "test.js", `const assert = require("node:assert");\nconst { loadAll } = require("./loader.js");\nloadAll([1, 2, 3]).then((results) => {\n  assert.deepStrictEqual(results, ["item-1", "item-2", "item-3"]);\n  console.log("ok");\n});\n`);
    },
    score: (dir) => scoreByTest(dir),
  },
  {
    id: "gitignore-hygiene",
    prompt: "Create a .gitignore for this Node project ignoring: node_modules, the dist build output, .env files, and all *.log files.",
    setup(dir) {
      write(dir, "index.js", "console.log('app');\n");
      write(dir, "package.json", JSON.stringify({ name: "app", version: "1.0.0" }, null, 2));
    },
    score(dir) {
      let content: string;
      try {
        content = read(dir, ".gitignore");
      } catch {
        return { pass: false, notes: ".gitignore not created" };
      }
      const lines = content.split("\n").map((line) => line.trim().replace(/\/$/, ""));
      const wants: Array<[string, (line: string) => boolean]> = [
        ["node_modules", (line) => line === "node_modules" || line === "/node_modules"],
        ["dist", (line) => line === "dist" || line === "/dist"],
        [".env", (line) => line === ".env" || line === ".env*" || line === "*.env"],
        ["*.log", (line) => line === "*.log"],
      ];
      for (const [label, match] of wants) {
        if (!lines.some(match)) return { pass: false, notes: `missing ${label}` };
      }
      return { pass: true };
    },
  },
];

export function selectTasks(filter?: string): EvalTask[] {
  if (!filter) return TASKS;
  const wanted = filter.split(",").map((token) => token.trim()).filter(Boolean);
  const unknown = wanted.filter((id) => !TASKS.some((task) => task.id === id));
  if (unknown.length > 0) {
    throw new Error(`Unknown task id(s): ${unknown.join(", ")}. Known: ${TASKS.map((task) => task.id).join(", ")}`);
  }
  return TASKS.filter((task) => wanted.includes(task.id));
}
