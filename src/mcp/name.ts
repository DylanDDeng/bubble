/**
 * MCP tool / server name normalization.
 *
 * Mirrors Claude Code's convention so that permission rules written for Claude
 * Code-style `mcp__<server>__<tool>` names work the same here.
 *
 * The OpenAI tool name pattern is roughly /^[a-zA-Z0-9_-]{1,64}$/. We replace
 * any character outside that set with an underscore. Server and tool names are
 * normalized independently so a "." or " " in a server name can't collide with
 * the "__" delimiter.
 */

export function normalizeNameForMCP(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function getMcpPrefix(serverName: string): string {
  return `mcp__${normalizeNameForMCP(serverName)}__`;
}

export function buildMcpToolName(serverName: string, toolName: string): string {
  return `${getMcpPrefix(serverName)}${normalizeNameForMCP(toolName)}`;
}

/**
 * Parse a tool name back to its server + tool components.
 *
 * Known limitation (inherited from Claude Code): if a server name contains
 * "__", the split is ambiguous. In that case we greedily take the first segment
 * as the server. Since server names come from user config and typically don't
 * contain double underscores, this is acceptable in v1.
 */
export function mcpInfoFromString(toolString: string): {
  serverName: string;
  toolName: string;
} | null {
  const parts = toolString.split("__");
  if (parts.length < 3 || parts[0] !== "mcp") return null;
  const serverName = parts[1];
  if (!serverName) return null;
  const toolName = parts.slice(2).join("__");
  if (!toolName) return null;
  return { serverName, toolName };
}
