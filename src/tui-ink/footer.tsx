import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "./theme.js";
import type { PermissionMode } from "../types.js";
import { PERMISSION_MODE_INFO } from "../permission/mode.js";

export interface FooterData {
  mode?: PermissionMode;
  goalLine?: string;
  runtimeLabel?: string;
  /** Friendly working directory (e.g. `~/project`). */
  cwd?: string;
  /** Current git branch, when the cwd is a git repo. */
  branch?: string;
  /** Display name of the active model. */
  model?: string;
  /** Current session title, when one has been assigned. */
  sessionTitle?: string;
  /** Compact context usage, e.g. `42K/500K`. */
  contextUsage?: string;
}

/**
 * Bottom status line. Always surfaces a `cwd | branch | model | title | ctx`
 * row (each segment only when its data is present), and appends the
 * permission-mode badge for non-default modes. Renders nothing (zero rows)
 * when no data is available.
 */
export function FooterBar({ data }: { data: FooterData }) {
  const theme = useTheme();
  const showMode = !!data.mode && data.mode !== "default";
  const goalLine = data.goalLine?.trim();
  const runtimeLabel = data.runtimeLabel?.trim();

  const segments: Array<{ key: string; text: string; color: string }> = [];
  if (data.cwd?.trim()) segments.push({ key: "cwd", text: data.cwd.trim(), color: theme.muted });
  if (data.branch?.trim()) segments.push({ key: "branch", text: data.branch.trim(), color: theme.muted });
  if (data.model?.trim()) segments.push({ key: "model", text: data.model.trim(), color: theme.accent });
  if (data.sessionTitle?.trim()) segments.push({ key: "title", text: data.sessionTitle.trim(), color: theme.muted });
  if (data.contextUsage?.trim()) segments.push({ key: "ctx", text: data.contextUsage.trim(), color: theme.muted });

  if (!showMode && !goalLine && !runtimeLabel && segments.length === 0) return null;

  return (
    <Box paddingX={1} flexShrink={0} flexDirection="column">
      {goalLine && <GoalBadge line={goalLine} />}
      {runtimeLabel && <RuntimeBadge label={runtimeLabel} />}
      {(segments.length > 0 || showMode) && (
        <Box>
          {showMode && (
            <React.Fragment>
              <ModeBadge mode={data.mode} />
              {segments.length > 0 && <Text color={theme.muted}> | </Text>}
            </React.Fragment>
          )}
          {segments.map((segment, index) => (
            <React.Fragment key={segment.key}>
              {index > 0 && <Text color={theme.muted}> | </Text>}
              <Text color={segment.color}>{segment.text}</Text>
            </React.Fragment>
          ))}
        </Box>
      )}
    </Box>
  );
}

function RuntimeBadge({ label }: { label: string }) {
  const theme = useTheme();
  return <Text color={theme.accent}>{label}</Text>;
}

function GoalBadge({ line }: { line: string }) {
  const theme = useTheme();
  return (
    <Text color={theme.muted}>
      {line}
    </Text>
  );
}

function ModeBadge({ mode }: { mode?: PermissionMode }) {
  const theme = useTheme();
  if (!mode || mode === "default") return null;
  const info = PERMISSION_MODE_INFO[mode];
  const color = (theme as unknown as Record<string, string>)[info.color] ?? theme.muted;
  const symbol = info.symbol ? `${info.symbol} ` : "";
  return (
    <Text color={color} bold>
      {symbol}
      {info.shortTitle} on
    </Text>
  );
}

export function buildFooterData(input: FooterData): FooterData {
  return input;
}
