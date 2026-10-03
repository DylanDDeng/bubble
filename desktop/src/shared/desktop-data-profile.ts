import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type DesktopDataProfile = 'production' | 'dev' | 'qa';

function canonicalPath(value: string): string {
  let parent = resolve(value);
  const suffix: string[] = [];
  while (!existsSync(parent)) {
    const next = dirname(parent);
    if (next === parent) break;
    suffix.unshift(relative(next, parent));
    parent = next;
  }
  return resolve(realpathSync(parent), ...suffix);
}

function overlaps(a: string, b: string): boolean {
  const within = (root: string, target: string) => {
    const rest = relative(root, target);
    return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
  };
  return within(a, b) || within(b, a);
}

export function resolveDesktopDataProfile(options: {
  profile: string;
  appData: string;
  home: string;
  qaRoot?: string;
  legacyUserData?: string;
}) {
  const { profile, appData, home } = options;
  if (!['production', 'dev', 'qa'].includes(profile)) throw new Error(`Unknown desktop data profile: ${profile}`);
  const production = { userData: join(appData, 'Bubble'), agentHome: join(home, '.bubble') };
  const dev = { userData: join(appData, 'Bubble Dev'), agentHome: join(home, '.bubble-dev') };
  let paths = profile === 'dev' ? dev : production;
  if (profile === 'qa') {
    if (options.qaRoot) paths = { userData: join(resolve(options.qaRoot), 'desktop'), agentHome: join(resolve(options.qaRoot), 'agent') };
    else if (options.legacyUserData) {
      paths = { userData: resolve(options.legacyUserData), agentHome: join(resolve(options.legacyUserData), 'agent') };
    } else throw new Error('QA requires a separate data root. Use npm run desktop:qa.');
  }
  if (profile !== 'production') {
    const protectedPaths = profile === 'qa' ? [...Object.values(production), ...Object.values(dev)] : Object.values(production);
    for (const target of Object.values(paths)) {
      for (const protectedPath of protectedPaths) {
        if (overlaps(canonicalPath(target), canonicalPath(protectedPath))) {
          throw new Error(`Refusing overlapping ${profile} and protected data directories: ${target}`);
        }
      }
    }
  }
  return { profile: profile as DesktopDataProfile, ...paths, appName: profile === 'production' ? 'Bubble' : profile === 'dev' ? 'Bubble Dev' : 'Bubble QA' };
}
