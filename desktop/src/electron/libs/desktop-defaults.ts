import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

/** First-run defaults only. Never import Aegis accounts, tasks, or schedules. */
export function initializeDesktopDefaults(): void {
  const home = app.getPath('userData');
  const stateFile = join(home, 'renderer-state.json');
  if (existsSync(stateFile)) return;
  const appearance = JSON.parse(readFileSync(join(app.getAppPath(), 'appearance-reference.json'), 'utf8'));
  mkdirSync(join(home, 'skins'), { recursive: true });
  copyFileSync(join(app.getAppPath(), 'build/skins/aegis-reference.png'), join(home, 'skins/aegis-reference.png'));
  writeFileSync(stateFile, JSON.stringify({
    'cowork-app-storage': JSON.stringify({ state: appearance, version: 0 }),
    'cowork.preferredProvider': 'bubble',
    'aegis-onboarding-complete': 'true',
  }, null, 2));
  const resumeFile = join(home, 'ui-resume-state.json');
  if (!existsSync(resumeFile)) {
    let projectCwd: string | null = null;
    try { projectCwd = JSON.parse(readFileSync(join(home, 'desktop.json'), 'utf8')).projects?.[0] || null; } catch { /* first run */ }
    writeFileSync(resumeFile, JSON.stringify({ projectCwd, projectTreeCollapsed: true, showNewSession: true }));
  }
}
