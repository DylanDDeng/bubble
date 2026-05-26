import { spawn } from "node:child_process";

export async function copyTextToClipboard(text: string): Promise<void> {
  if (process.platform === "darwin") {
    await writeToProcess("pbcopy", [], text);
    return;
  }

  if (process.platform === "win32") {
    await writeToProcess("powershell", [
      "-NoProfile",
      "-Command",
      "Set-Clipboard -Value ([Console]::In.ReadToEnd())",
    ], text);
    return;
  }

  const candidates: Array<[string, string[]]> = [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ];

  let lastError: unknown;
  for (const [command, args] of candidates) {
    try {
      await writeToProcess(command, args, text);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("No clipboard command available");
}

function writeToProcess(command: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });

    child.stdin.end(input);
  });
}
