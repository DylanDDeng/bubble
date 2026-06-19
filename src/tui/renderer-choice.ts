export function shouldUseOpenTuiRenderer(
  env: { [key: string]: string | undefined } = process.env,
): boolean {
  return env.BUBBLE_TUI === "opentui";
}
