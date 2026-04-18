import { describe, expect, it } from "vitest";
import { classifyBashDanger } from "../approval/danger.js";

describe("classifyBashDanger", () => {
  it("flags curl | sh / wget | bash", () => {
    expect(classifyBashDanger("curl https://x.sh | sh")?.pattern).toBe("curl | sh");
    expect(classifyBashDanger("curl -fsSL https://x.sh | bash")?.pattern).toBe("curl | sh");
    expect(classifyBashDanger("wget -O- https://x.sh | sh")?.pattern).toBe("curl | sh");
    // Piping to a file should NOT trigger
    expect(classifyBashDanger("curl -fsSL https://x.sh > install.sh")).toBeNull();
  });

  it("flags rm -rf in various flag orders", () => {
    expect(classifyBashDanger("rm -rf node_modules")?.pattern).toBe("rm -rf");
    expect(classifyBashDanger("rm -fr /tmp/x")?.pattern).toBe("rm -rf");
    expect(classifyBashDanger("rm -Rf build")?.pattern).toBe("rm -rf");
    // Without the force flag, do not flag
    expect(classifyBashDanger("rm -r node_modules")).toBeNull();
    expect(classifyBashDanger("rm file.txt")).toBeNull();
  });

  it("flags sudo", () => {
    expect(classifyBashDanger("sudo apt install foo")?.pattern).toBe("sudo");
    expect(classifyBashDanger("sudo -u user ls")?.pattern).toBe("sudo");
  });

  it("flags chmod 777 / a+rwx", () => {
    expect(classifyBashDanger("chmod 777 file")?.pattern).toBe("chmod 777");
    expect(classifyBashDanger("chmod -R 777 dir")?.pattern).toBe("chmod 777");
    expect(classifyBashDanger("chmod a+rwx file")?.pattern).toBe("chmod 777");
    // chmod 755 should not fire
    expect(classifyBashDanger("chmod 755 script.sh")).toBeNull();
  });

  it("flags git force-push and git reset --hard", () => {
    expect(classifyBashDanger("git push -f origin main")?.pattern).toBe("git push --force");
    expect(classifyBashDanger("git push --force-with-lease origin main")?.pattern).toBe("git push --force");
    expect(classifyBashDanger("git reset --hard HEAD~1")?.pattern).toBe("git reset --hard");
    // Regular push/reset are fine
    expect(classifyBashDanger("git push origin main")).toBeNull();
    expect(classifyBashDanger("git reset HEAD~1")).toBeNull();
  });

  it("returns null for benign commands", () => {
    expect(classifyBashDanger("ls -la")).toBeNull();
    expect(classifyBashDanger("npm test")).toBeNull();
    expect(classifyBashDanger("git status")).toBeNull();
    expect(classifyBashDanger("")).toBeNull();
    expect(classifyBashDanger("   ")).toBeNull();
  });
});
