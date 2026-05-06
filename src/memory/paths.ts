import { existsSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
export { getBubbleHome } from "../bubble-home.js";
import { getBubbleHome } from "../bubble-home.js";

export interface MemoryPaths {
  globalRoot: string;
  globalAgents: string;
  globalSummary: string;
  globalMemory: string;
  globalRawMemories: string;
  globalRolloutSummaries: string;
  globalSkills: string;
  globalExtensions: string;
  globalDatabase: string;
  projectRoot: string;
  projectBubbleRoot: string;
  projectAgents: string;
  projectLocalAgents: string;
}

export function getMemoryPaths(cwd: string): MemoryPaths {
  const bubbleHome = getBubbleHome();
  const globalRoot = join(bubbleHome, "memories");
  const projectRoot = findProjectRoot(cwd);
  const projectBubbleRoot = join(projectRoot, ".bubble");

  return {
    globalRoot,
    globalAgents: join(bubbleHome, "AGENTS.md"),
    globalSummary: join(globalRoot, "memory_summary.md"),
    globalMemory: join(globalRoot, "MEMORY.md"),
    globalRawMemories: join(globalRoot, "raw_memories.md"),
    globalRolloutSummaries: join(globalRoot, "rollout_summaries"),
    globalSkills: join(globalRoot, "skills"),
    globalExtensions: join(globalRoot, "memories_extensions"),
    globalDatabase: join(globalRoot, "state.sqlite"),
    projectRoot,
    projectBubbleRoot,
    projectAgents: join(projectRoot, "AGENTS.md"),
    projectLocalAgents: join(projectBubbleRoot, "AGENTS.md"),
  };
}

export function findProjectRoot(cwd: string): string {
  let current = resolve(cwd);
  const root = parse(current).root;

  while (true) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }
    if (current === root) {
      return resolve(cwd);
    }
    current = dirname(current);
  }
}
