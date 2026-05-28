import { describe, expect, it } from "vitest";
import { compareVersions, upgradeCommandFor, PACKAGE_NAME } from "../update/index.js";

describe("compareVersions", () => {
  it("orders numeric cores", () => {
    expect(compareVersions("0.0.15", "0.0.14")).toBe(1);
    expect(compareVersions("0.0.14", "0.0.15")).toBe(-1);
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
    expect(compareVersions("0.1.0", "0.0.99")).toBe(1);
    expect(compareVersions("0.0.14", "0.0.14")).toBe(0);
  });

  it("tolerates a leading v and short versions", () => {
    expect(compareVersions("v0.0.15", "0.0.14")).toBe(1);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
  });

  it("treats a release as newer than a pre-release of the same core", () => {
    expect(compareVersions("0.0.14", "0.0.14-beta.1")).toBe(1);
    expect(compareVersions("0.0.14-beta.1", "0.0.14")).toBe(-1);
    expect(compareVersions("0.0.14-beta.2", "0.0.14-beta.1")).toBe(1);
  });
});

describe("upgradeCommandFor", () => {
  const spec = `${PACKAGE_NAME}@latest`;

  it("maps known managers to global install commands", () => {
    expect(upgradeCommandFor("npm")).toEqual({ cmd: "npm", args: ["install", "-g", spec] });
    expect(upgradeCommandFor("bun")).toEqual({ cmd: "bun", args: ["add", "-g", spec] });
    expect(upgradeCommandFor("pnpm")).toEqual({ cmd: "pnpm", args: ["add", "-g", spec] });
    expect(upgradeCommandFor("yarn")).toEqual({ cmd: "yarn", args: ["global", "add", spec] });
  });

  it("defaults unknown to npm and returns null for homebrew", () => {
    expect(upgradeCommandFor("unknown")).toEqual({ cmd: "npm", args: ["install", "-g", spec] });
    expect(upgradeCommandFor("homebrew")).toBeNull();
  });
});
