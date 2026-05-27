/** @jsxImportSource @opentui/react */
import React from "react";
import { useTheme } from "../theme.js";
import { ApprovalSelect, type ApprovalOption } from "./select.js";
import { DiffView } from "./diff-view.js";
import type { ApprovalDecision, ApprovalRequest } from "../../approval/types.js";
import { inferBashPrefix } from "../../approval/session-cache.js";
import { classifyBashDanger } from "../../approval/danger.js";

interface ApprovalDialogProps {
  request: ApprovalRequest;
  onDecision: (decision: ApprovalDecision) => void;
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
  onAllowBashPrefix,
}: ApprovalDialogProps) {
  const theme = useTheme();
  const options = buildOptions(request);

  const onSubmit = (id: string, extras: { feedback?: string; editedValue?: string }) => {
    switch (id) {
      case "yes":
        onDecision({ action: "approve", feedback: extras.feedback });
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
    <box
      style={{
        flexDirection: "column",
        border: true,
        borderColor: theme.accent,
        paddingLeft: 1,
        paddingRight: 1,
        marginTop: 1,
        marginBottom: 1,
      }}
    >
      <text fg={theme.accent} attributes={1}>
        {title}
      </text>
      <box style={{ flexDirection: "column", marginTop: 1 }}>
        <RequestPreview request={request} />
      </box>
      <box style={{ marginTop: 1 }}>
        <text>{question}</text>
      </box>
      <box style={{ marginTop: 1 }}>
        <ApprovalSelect
          options={options}
          onSubmit={onSubmit}
          onCancel={onCancel}
          hint="↑↓ choose · Enter select · Tab add feedback · Esc reject"
        />
      </box>
    </box>
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

  // edit / write / patch
  return [
    { id: "yes", label: "Yes", allowAmend: true, amendPlaceholder: "and tell Claude what to do next" },
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
    case "patch":
      return "Apply patch";
    case "write":
      return req.fileExists ? "Overwrite file" : "Create file";
    case "bash":
      return "Bash command";
    case "lsp":
      return "Language server operation";
  }
}

function dialogQuestion(req: ApprovalRequest): string {
  switch (req.type) {
    case "edit":
      return `Do you want to make this edit to ${basename(req.path)}?`;
    case "patch":
      return `Do you want to apply this patch to ${req.paths.length} file${req.paths.length === 1 ? "" : "s"}?`;
    case "write":
      return `Do you want to ${req.fileExists ? "overwrite" : "create"} ${basename(req.path)}?`;
    case "bash":
      return "Do you want to proceed?";
    case "lsp":
      return `Do you want to run ${req.operation} on ${basename(req.path)}?`;
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
    case "patch":
      return <DiffView diff={request.diff} />;
    case "write":
      return <WritePreview path={request.path} content={request.content} />;
  }
}

function BashPreview({ command, cwd }: { command: string; cwd: string }) {
  const theme = useTheme();
  const danger = classifyBashDanger(command);
  return (
    <box style={{ flexDirection: "column" }}>
      <box style={{ flexDirection: "row" }}>
        <text fg={theme.muted}>$ </text>
        <text>{command}</text>
      </box>
      <text fg={theme.muted}>{`cwd: ${compressHome(cwd)}`}</text>
      {danger && (
        <box style={{ marginTop: 1, flexDirection: "row" }}>
          <text fg={theme.warning} attributes={1}>
            {`⚠ ${danger.pattern}:`}
          </text>
          <text fg={theme.warning}>{` ${danger.message}`}</text>
        </box>
      )}
    </box>
  );
}

const MAX_WRITE_PREVIEW_LINES = 20;

function WritePreview({ path, content }: { path: string; content: string }) {
  const theme = useTheme();
  const lines = content.split("\n");
  const shown = lines.slice(0, MAX_WRITE_PREVIEW_LINES);
  const overflow = lines.length - shown.length;
  const totalBytes = Buffer.byteLength(content, "utf-8");
  return (
    <box style={{ flexDirection: "column" }}>
      <box style={{ flexDirection: "row" }}>
        <text fg={theme.muted}>{compressHome(path)}</text>
        <text fg={theme.muted}>{` · ${lines.length} line${lines.length === 1 ? "" : "s"} · ${formatBytes(totalBytes)}`}</text>
      </box>
      <box style={{ flexDirection: "column", marginTop: 1 }}>
        {shown.map((line, i) => (
          <text key={i} fg="green">
            {"+ "}
            {line || " "}
          </text>
        ))}
        {overflow > 0 && (
          <text fg={theme.muted}>{`… ${overflow} more line${overflow === 1 ? "" : "s"}`}</text>
        )}
      </box>
    </box>
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
