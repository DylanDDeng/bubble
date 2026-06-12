import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "./theme.js";
import type { PermissionMode } from "../types.js";
import { PERMISSION_MODE_INFO } from "../permission/mode.js";

export interface FooterData {
  mode?: PermissionMode;
}

/**
 * Bottom status line. Path / provider / model moved into the welcome banner;
 * the footer only surfaces the permission-mode badge, so it renders nothing
 * (zero rows) in the default mode.
 */
export function FooterBar({ data }: { data: FooterData }) {
  if (!data.mode || data.mode === "default") return null;
  return (
    <Box paddingX={1} flexShrink={0}>
      <ModeBadge mode={data.mode} />
    </Box>
  );
}

function ModeBadge({ mode }: { mode?: PermissionMode }) {
  const theme = useTheme();
  if (!mode || mode === "default") return null;
  const info = PERMISSION_MODE_INFO[mode];
  const color = (theme as unknown as Record<string, string>)[info.color] ?? theme.muted;
  const symbol = info.symbol ? `${info.symbol} ` : "";
  return (
    <>
      <Text color={color} bold>
        {symbol}
        {info.shortTitle} on
      </Text>
      <Text color={theme.muted}> ⇧⇥</Text>
    </>
  );
}

export function buildFooterData(input: FooterData): FooterData {
  return input;
}
