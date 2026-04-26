import type { ToolResult } from "../types.js";
import type { ApprovalController, ApprovalDecision, ApprovalRequest } from "./types.js";

/**
 * Runs a tool action through the approval controller. Returns either the
 * decision (on approve) or a pre-built rejection ToolResult (on reject or
 * no controller available to the tool).
 */
export async function gateToolAction(
  approval: ApprovalController | undefined,
  req: ApprovalRequest,
): Promise<{ approved: true; decision: ApprovalDecision } | { approved: false; result: ToolResult }> {
  if (!approval) {
    return { approved: true, decision: { action: "approve" } };
  }

  const decision = await approval.request(req);
  if (decision.action === "approve") {
    return { approved: true, decision };
  }

  const feedback = decision.feedback?.trim();
  const label = approvalRequestLabel(req);
  const message = feedback
    ? `${label} was rejected by the user. User feedback: ${feedback}`
    : `${label} was rejected by the user.`;
  return { approved: false, result: { content: message, isError: true } };
}

function approvalRequestLabel(req: ApprovalRequest): string {
  switch (req.type) {
    case "edit":
      return `Edit to ${req.path}`;
    case "write":
      return `${req.fileExists ? "Overwrite" : "Write"} to ${req.path}`;
    case "bash":
      return `Bash command \`${req.command}\``;
    case "lsp":
      return `LSP ${req.operation} on ${req.path}`;
  }
}
