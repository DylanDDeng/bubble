import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function expandHomePath(value: unknown): string {
  const text = String(value ?? "");
  if (text === "~") return homedir();
  if (text.startsWith("~/") || text.startsWith("~\\")) {
    return join(homedir(), text.slice(2));
  }
  return text;
}

export function resolveToolPath(cwd: string, value: unknown, fallback = "."): string {
  const text = String(value ?? "");
  const path = text === "" ? fallback : text;
  return resolve(cwd, expandHomePath(path));
}
