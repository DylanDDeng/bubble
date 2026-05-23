/**
 * Format an ApprovalRequest into a user-readable card body. Kept separate
 * from the UI controller so we can unit-test rendering without dragging in
 * the channel mocks.
 */

import type { ApprovalRequest } from "../../approval/types.js";

const COMMAND_PREVIEW_MAX = 1200;
const PATH_PREVIEW_MAX = 200;
const CONTENT_PREVIEW_MAX = 2000;
const DIFF_PREVIEW_MAX = 2400;

export interface ApprovalSummary {
  title: string;
  body: string;
}

export function formatApprovalRequest(req: ApprovalRequest): ApprovalSummary {
  switch (req.type) {
    case "bash":
      return {
        title: "执行命令",
        body: `\`\`\`bash\n${truncate(req.command, COMMAND_PREVIEW_MAX)}\n\`\`\`\n\n**cwd:** \`${truncate(req.cwd, PATH_PREVIEW_MAX)}\``,
      };
    case "write":
      return {
        title: req.fileExists ? "覆盖文件" : "新建文件",
        body: [
          `**path:** \`${truncate(req.path, PATH_PREVIEW_MAX)}\``,
          req.diff
            ? `\n**diff:**\n\`\`\`diff\n${truncate(req.diff, DIFF_PREVIEW_MAX)}\n\`\`\``
            : `\n**content preview:**\n\`\`\`\n${truncate(req.content, CONTENT_PREVIEW_MAX)}\n\`\`\``,
        ].join("\n"),
      };
    case "edit":
      return {
        title: "编辑文件",
        body: [
          `**path:** \`${truncate(req.path, PATH_PREVIEW_MAX)}\``,
          `\n**diff:**\n\`\`\`diff\n${truncate(req.diff, DIFF_PREVIEW_MAX)}\n\`\`\``,
        ].join("\n"),
      };
    case "lsp":
      return {
        title: `LSP 操作 (${req.operation})`,
        body: `**path:** \`${truncate(req.path, PATH_PREVIEW_MAX)}\``,
      };
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
