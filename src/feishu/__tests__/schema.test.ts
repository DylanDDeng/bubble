import { describe, expect, it } from "vitest";
import {
  validateFeishuConfig,
  validateScopesFile,
  validateScopeConfig,
  validateSessionsFile,
  validateSessionEntry,
} from "../schema.js";
import { DEFAULT_GLOBAL_LIMITS, DEFAULT_PREFERENCES } from "../types.js";

describe("validateFeishuConfig", () => {
  it("accepts a minimal valid config and fills defaults", () => {
    const result = validateFeishuConfig({
      version: 1,
      app: {
        appId: "cli_abc",
        ownerOpenId: "ou_owner",
        secretRef: { source: "keystore", name: "default" },
        encryptCheck: "xx",
      },
    });
    expect(result.ok).toBe(true);
    expect(result.value?.preferences).toEqual(DEFAULT_PREFERENCES);
    expect(result.value?.globalLimits).toEqual(DEFAULT_GLOBAL_LIMITS);
  });

  it("rejects missing appId", () => {
    const result = validateFeishuConfig({
      version: 1,
      app: { ownerOpenId: "x", secretRef: { source: "keystore", name: "default" }, encryptCheck: "" },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("appId");
  });

  it("rejects unknown render mode", () => {
    const result = validateFeishuConfig({
      version: 1,
      app: { appId: "x", ownerOpenId: "y", secretRef: { source: "keystore", name: "n" }, encryptCheck: "" },
      preferences: { renderMode: "voice" },
    });
    expect(result.ok).toBe(false);
  });

  it("accepts env-source secretRef", () => {
    const result = validateFeishuConfig({
      version: 1,
      app: {
        appId: "x",
        ownerOpenId: "y",
        secretRef: { source: "env", varName: "FEISHU_SECRET" },
        encryptCheck: "",
      },
    });
    expect(result.ok).toBe(true);
  });
});

describe("validateScopeConfig", () => {
  it("rejects empty allowedUsers", () => {
    const result = validateScopeConfig({
      cwd: "/tmp",
      displayName: "x",
      allowedUsers: [],
      admins: [],
      defaultPermissionMode: "default",
      model: null,
      createdAt: 0,
      lastActiveAt: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("allowedUsers");
  });

  it("rejects invalid permissionMode", () => {
    const result = validateScopeConfig({
      cwd: "/tmp",
      displayName: "x",
      allowedUsers: ["ou_x"],
      admins: [],
      defaultPermissionMode: "yolo",
      model: null,
      createdAt: 0,
      lastActiveAt: 0,
    });
    expect(result.ok).toBe(false);
  });

  it("accepts a complete valid scope", () => {
    const result = validateScopeConfig({
      cwd: "/tmp",
      displayName: "x",
      allowedUsers: ["ou_x"],
      admins: ["ou_x"],
      defaultPermissionMode: "default",
      model: null,
      createdAt: 1,
      lastActiveAt: 1,
    });
    expect(result.ok).toBe(true);
  });
});

describe("validateScopesFile", () => {
  it("collects errors per-scope and overall", () => {
    const result = validateScopesFile({
      version: 1,
      scopes: {
        oc_a: {
          cwd: "/tmp",
          displayName: "a",
          allowedUsers: [],
          admins: [],
          defaultPermissionMode: "default",
          model: null,
          createdAt: 0,
          lastActiveAt: 0,
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("oc_a"))).toBe(true);
  });
});

describe("validateSessionsFile + validateSessionEntry", () => {
  it("accepts a valid entry", () => {
    const e = validateSessionEntry({
      sessionFile: "/foo.jsonl",
      cwd: "/tmp",
      permissionMode: "default",
      lastActiveAt: 0,
    });
    expect(e.ok).toBe(true);
  });

  it("rejects unknown permissionMode in entry", () => {
    const e = validateSessionEntry({
      sessionFile: "/x",
      cwd: "/y",
      permissionMode: "yolo",
      lastActiveAt: 0,
    });
    expect(e.ok).toBe(false);
  });

  it("validateSessionsFile passes through valid contents", () => {
    const r = validateSessionsFile({
      version: 1,
      sessions: {
        "oc_a:ou_x": {
          sessionFile: "/a",
          cwd: "/b",
          permissionMode: "default",
          lastActiveAt: 0,
        },
      },
    });
    expect(r.ok).toBe(true);
  });
});
