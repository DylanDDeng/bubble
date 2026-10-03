import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Never read or write the developer's real ~/.bubble while discovering skills.
process.env.BUBBLE_HOME = mkdtempSync(join(tmpdir(), "bubble-skill-home-"));

void (async () => {
  const { SkillRegistry } = await import("../../../src/skills/registry");
  // The desktop ships bubble-design in skills/ and passes that directory to every Bubble turn.
  const bundled = join(import.meta.dirname, "../../skills");
  const registry = new SkillRegistry({ cwd: mkdtempSync(join(tmpdir(), "bubble-skill-cwd-")), skillPaths: [bundled] });
  const skill = registry.get("bubble-design");
  assert(skill, "bubble-design is discovered from the bundled directory: ");
  assert(skill.meta.description.length > 40, "a description the model can match on");
  assert.equal(skill.source, "configured");
  for (const section of ["Read the request first", "Start from what already exists", "Boards", "Tokens first", "Avoid the generated look", "Check once with a preview"])
    assert(skill.content.includes(section), "covers: " + section);
  // The tools carry the rules and point the model at the skill for the craft.
  const tools = readFileSync(join(import.meta.dirname, "../../src/electron/design/tools.ts"), "utf8");
  assert(tools.includes("load the bubble-design skill"), "design tools point to the skill");
  console.log("Design skill: bundled bubble-design discovered and referenced by the design tools passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
