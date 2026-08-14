/**
 * /stats overlay: range-switching, scrollable usage panel.
 */
import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { formatStatsPanelBody, rangeLabel, type StatsRange, type UsageStatsBundle } from "../stats/usage.js";
import { useTheme } from "./theme.js";
import { isKeyReleaseEvent } from "./key-events.js";

export function StatsPanel({
  panel,
  terminalColumns,
  terminalRows,
  onRangeChange,
  onCancel,
}: {
  panel: { range: StatsRange; bundle: UsageStatsBundle };
  terminalColumns: number;
  terminalRows: number;
  onRangeChange: (range: StatsRange) => void;
  onCancel: () => void;
}) {
  const theme = useTheme();
  const [scroll, setScroll] = useState(0);
  const bodyWidth = Math.max(48, Math.min(92, terminalColumns - 6));
  const lines = useMemo(
    () => formatStatsPanelBody(panel.bundle.ranges[panel.range], bodyWidth).split("\n"),
    [bodyWidth, panel.bundle, panel.range],
  );
  const maxVisible = Math.max(5, Math.min(16, terminalRows - 10));
  const maxScroll = Math.max(0, lines.length - maxVisible);

  useEffect(() => {
    setScroll(0);
  }, [panel.range]);

  useEffect(() => {
    setScroll((current) => Math.min(current, maxScroll));
  }, [maxScroll]);

  useInput((input, key) => {
    if (isKeyReleaseEvent(key)) return;
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.tab) {
      onRangeChange(panel.range === "30d" ? "7d" : "30d");
      return;
    }
    if (key.leftArrow || input === "h") {
      onRangeChange("7d");
      return;
    }
    if (key.rightArrow || input === "l") {
      onRangeChange("30d");
      return;
    }
    if (key.upArrow) {
      setScroll((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setScroll((current) => Math.min(maxScroll, current + 1));
      return;
    }
    if (key.pageUp) {
      setScroll((current) => Math.max(0, current - maxVisible));
      return;
    }
    if (key.pageDown) {
      setScroll((current) => Math.min(maxScroll, current + maxVisible));
    }
  });

  const visible = lines.slice(scroll, scroll + maxVisible);
  const generatedAt = panel.bundle.generatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <Box
      flexDirection="column"
      marginY={1}
      paddingX={1}
      borderStyle="round"
      borderColor={theme.borderActive}
    >
      <Text bold color={theme.accent}>Stats</Text>
      <Text color={theme.muted}>
        {rangeLabel(panel.range)} · generated {generatedAt}
      </Text>
      <Text color={theme.muted}>Left/Right range · Up/Down scroll · Tab toggle · Esc close</Text>
      <Box flexDirection="column" marginTop={1}>
        {visible.map((line, index) => {
          const key = `${scroll + index}-${line}`;
          const heading = line === "Activity" || line === "Model usage" || line === "Summary";
          return (
            <Text key={key} color={heading ? theme.accent : undefined} bold={heading}>
              {line || " "}
            </Text>
          );
        })}
      </Box>
      {maxScroll > 0 && (
        <Text color={theme.muted}>
          {scroll + 1}-{Math.min(lines.length, scroll + maxVisible)} of {lines.length}
        </Text>
      )}
    </Box>
  );
}
