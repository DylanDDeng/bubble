import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { ApprovalSelect, type ApprovalOption } from "./select.js";
import { DiffView } from "./diff-view.js";
import type { ApprovalDecision, ApprovalRequest } from "../../approval/types.js";
import { inferBashPrefix } from "../../approval/session-cache.js";
import { classifyBashDanger } from "../../approval/danger.js";

interface ApprovalDialogProps {
  request: ApprovalRequest;
  onDecision: (decision: ApprovalDecision) => void;
  /**
   * Selecting "Yes, allow all edits during this session" calls this with
   * "acceptEdits" so the harness can flip the agent mode before the
   * approve decision is returned.
   */
  onRequestModeSwitch?: (mode: "acceptEdits") => void;
  /**
   * Selecting "Yes, and don't ask again for <prefix>" calls this with the
   * (possibly user-edited) prefix so the harness can register it in the
   * session-scoped bash allowlist.
   */
  onAllowBashPrefix?: (prefix: string) => void;
}

export function ApprovalDialog({
  request,
  onDecision,
  onRequestModeSwitch,
  onAllowBashPrefix,
}: ApprovalDialogProps) {
  const options = buildOptions(request);

  const onSubmit = (id: string, extras: { feedback?: string; editedValue?: string }) => {
    switch (id) {
      case "yes":
        onDecision({ action: "approve", feedback: extras.feedback });
        return;
      case "yes-session-edits":
        onRequestModeSwitch?.("acceptEdits");
        onDecision({ action: "approve" });
        return;
      case "yes-bash-prefix": {
        const prefix = (extras.editedValue ?? "").trim();
        if (prefix) onAllowBashPrefix?.(prefix);
        onDecision({ action: "approve" });
        return;
      }
      case "no":
      default:
        onDecision({ action: "reject", feedback: extras.feedback });
        return;
    }
  };

  const onCancel = () => onDecision({ action: "reject" });

  const title = dialogTitle(request);
  const question = dialogQuestion(request);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginY={1}>
      <Text color={theme.accent} bold>
        {title}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <RequestPreview request={request} />
      </Box>
      <Box marginTop={1}>
        <Text>{question}</Text>
      </Box>
      <Box marginTop={1}>
        <ApprovalSelect
          options={options}
          onSubmit={onSubmit}
          onCancel={onCancel}
          hint="↑↓ choose · Enter select · Tab add feedback · Esc reject"
        />
      </Box>
    </Box>
  );
}

function buildOptions(request: ApprovalRequest): ApprovalOption[] {
  if (request.type === "bash") {
    const prefix = inferBashPrefix(request.command);
    return [
      { id: "yes", label: "Yes", allowAmend: true, amendPlaceholder: "and tell Claude what to do next" },
      {
        id: "yes-bash-prefix",
        label: "Yes, and don't ask again for",
        editableValue: {
          initial: prefix,
          placeholder: "command prefix (e.g. npm run:*)",
        },
      },
      {
        id: "no",
        label: "No",
        description: "(tab to add feedback)",
        allowAmend: true,
        amendPlaceholder: "and tell Claude what to do differently",
      },
    ];
  }

  // edit / write
  return [
    { id: "yes", label: "Yes", allowAmend: true, amendPlaceholder: "and tell Claude what to do next" },
    {
      id: "yes-session-edits",
      label: "Yes, allow all edits during this session (⇧⇥)",
    },
    {
      id: "no",
      label: "No",
      description: "(tab to add feedback)",
      allowAmend: true,
      amendPlaceholder: "and tell Claude what to do differently",
    },
  ];
}

function dialogTitle(req: ApprovalRequest): string {
  switch (req.type) {
    case "edit":
      return "Edit file";
    case "write":
      return req.fileExists ? "Overwrite file" : "Create file";
    case "bash":
      return "Bash command";
  }
}

function dialogQuestion(req: ApprovalRequest): string {
  switch (req.type) {
    case "edit":
      return `Do you want to make this edit to ${basename(req.path)}?`;
    case "write":
      return `Do you want to ${req.fileExists ? "overwrite" : "create"} ${basename(req.path)}?`;
    case "bash":
      return "Do you want to proceed?";
  }
}

function basename(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function RequestPreview({ request }: { request: ApprovalRequest }) {
  switch (request.type) {
    case "bash":
      return <BashPreview command={request.command} cwd={request.cwd} />;
    case "edit":
      return <DiffView diff={request.diff} />;
    case "write":
      return <WritePreview path={request.path} content={request.content} />;
  }
}

function BashPreview({ command, cwd }: { command: string; cwd: string }) {
  const danger = classifyBashDanger(command);
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.muted}>$ </Text>
        <Text>{command}</Text>
      </Box>
      <Text color={theme.muted}>cwd: {compressHome(cwd)}</Text>
      {danger && (
        <Box marginTop={1}>
          <Text color={theme.warning} bold>
            ⚠ {danger.pattern}:
          </Text>
          <Text color={theme.warning}> {danger.message}</Text>
        </Box>
      )}
    </Box>
  );
}

const MAX_WRITE_PREVIEW_LINES = 20;

function WritePreview({ path, content }: { path: string; content: string }) {
  const lines = content.split("\n");
  const shown = lines.slice(0, MAX_WRITE_PREVIEW_LINES);
  const overflow = lines.length - shown.length;
  const totalBytes = Buffer.byteLength(content, "utf-8");
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.muted}>{compressHome(path)}</Text>
        <Text color={theme.muted}> · {lines.length} line{lines.length === 1 ? "" : "s"} · {formatBytes(totalBytes)}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {shown.map((line, i) => (
          <Text key={i} color="green">
            {"+ "}
            {line || " "}
          </Text>
        ))}
        {overflow > 0 && (
          <Text color={theme.muted}>… {overflow} more line{overflow === 1 ? "" : "s"}</Text>
        )}
      </Box>
    </Box>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function compressHome(p: string): string {
  const home = process.env.HOME || "";
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}
