import { homedir } from "node:os";
import { resolve } from "node:path";
import { getBubbleHome } from "../bubble-home.js";

export function getSensitivePaths(): string[] {
  const bubbleHome = getBubbleHome();
  return [
    resolve(bubbleHome, "config.json"),
    resolve(bubbleHome, "auth.json"),
  ];
}

export function isSensitivePath(filePath: string): boolean {
  const resolved = resolve(filePath);
  return getSensitivePaths().includes(resolved);
}

export function referencesSensitivePath(command: string): boolean {
  const lower = command.toLowerCase();
  if (lower.includes("~/.bubble/config.json") || lower.includes("~/.bubble/auth.json")) {
    return true;
  }
  return getSensitivePaths().some((filePath) => {
    const normalized = filePath.replace(/\\/g, "/");
    return lower.includes(normalized.toLowerCase()) || lower.includes(normalized.toLowerCase().replace(homedir().toLowerCase(), "~"));
  });
}
