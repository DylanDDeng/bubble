/**
 * Test-only re-export of the upstream VirtualTerminal (xterm-headless based
 * terminal emulator) for Bubble's terminal-level suites.
 *
 * Compiled into dist (see tsconfig.build.json include) so both `tsc` (via
 * tsconfig paths) and Node can resolve `@bubblebrain-ai/pi-tui/testing`.
 * Vitest resolves the same specifier through an alias to TS source in
 * vitest.config.ts. Never imported by runtime product code.
 */
export { VirtualTerminal } from "../test/virtual-terminal.ts";
