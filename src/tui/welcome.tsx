import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";

interface WelcomeBannerProps {
  terminalColumns: number;
}

const LOGO_LINES = [
  "██████╗ ██╗   ██╗██████╗ ██████╗ ██╗     ███████╗",
  "██╔══██╗██║   ██║██╔══██╗██╔══██╗██║     ██╔════╝",
  "██████╔╝██║   ██║██████╔╝██████╔╝██║     █████╗  ",
  "██╔══██╗██║   ██║██╔══██╗██╔══██╗██║     ██╔══╝  ",
  "██████╔╝╚██████╔╝██████╔╝██████╔╝███████╗███████╗",
  "╚═════╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚══════╝",
];

const LOGO_WIDTH = 49;

export function WelcomeBanner({ terminalColumns }: WelcomeBannerProps) {
  const fitsWide = terminalColumns >= LOGO_WIDTH + 2;

  if (!fitsWide) {
    return (
      <Box alignSelf="center" paddingY={1}>
        <Text bold color={theme.userMessageText}>BUBBLE</Text>
      </Box>
    );
  }

  return (
    <Box alignSelf="center" flexDirection="column" paddingY={1}>
      {LOGO_LINES.map((line, idx) => (
        <Text key={idx} bold color={theme.userMessageText}>{line}</Text>
      ))}
    </Box>
  );
}
