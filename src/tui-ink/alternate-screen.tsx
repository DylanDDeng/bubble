import React from "react";

// xterm DECSET 1049: switch to alternate screen buffer and save cursor on
// enter, restore on leave. Identical to what less/vim use — content written
// in alt buffer never lands in the terminal's scrollback history.
const ENTER_ALT_SCREEN = "\x1b[?1049h";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";

let activeAlternateScreens = 0;

function enterAltScreen() {
  if (activeAlternateScreens === 0) {
    process.stdout.write(ENTER_ALT_SCREEN);
  }
  activeAlternateScreens += 1;
}

function leaveAltScreen() {
  if (activeAlternateScreens <= 0) return;
  activeAlternateScreens -= 1;
  if (activeAlternateScreens === 0) {
    process.stdout.write(LEAVE_ALT_SCREEN);
  }
}

// Belt-and-suspenders: if the process exits without React unmounting
// (crash, SIGINT racing past Ink's handlers), the terminal would be left
// stuck in the alt buffer with no visible output. Register once globally.
let cleanupRegistered = false;
function registerProcessCleanup() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const flush = () => {
    if (activeAlternateScreens > 0) {
      try { process.stdout.write(LEAVE_ALT_SCREEN); } catch { /* ignore */ }
      activeAlternateScreens = 0;
    }
  };
  process.on("exit", flush);
  process.on("SIGINT", flush);
  process.on("SIGTERM", flush);
  process.on("SIGHUP", flush);
}

/**
 * Mounts an xterm alternate-screen buffer for the lifetime of the children.
 * On unmount the primary buffer (and its scrollback) is restored exactly as
 * it was before mount, so toggling fullscreen mode mid-session doesn't lose
 * the user's previous shell history.
 */
export function AlternateScreen({ children }: { children: React.ReactNode }) {
  React.useEffect(() => {
    registerProcessCleanup();
    enterAltScreen();
    return () => {
      leaveAltScreen();
    };
  }, []);
  return <>{children}</>;
}
