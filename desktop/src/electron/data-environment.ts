// Must execute before importing stores, SDK adapters or any config readers.
import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolveDesktopDataProfile } from '../shared/desktop-data-profile';

const legacyUserData = (process.env.BUBBLE_DESKTOP_USER_DATA || process.env.AEGIS_USER_DATA_DIR)?.trim();
const profile = process.env.BUBBLE_DESKTOP_PROFILE?.trim()
  || (legacyUserData ? 'qa' : app.isPackaged ? 'production' : 'dev');
export const desktopDataProfile = resolveDesktopDataProfile({
  profile,
  appData: app.getPath('appData'),
  home: homedir(),
  qaRoot: process.env.BUBBLE_DESKTOP_QA_ROOT,
  legacyUserData,
});

// Failure is fatal: falling back to a shared directory would break isolation.
mkdirSync(desktopDataProfile.userData, { recursive: true });
mkdirSync(desktopDataProfile.agentHome, { recursive: true });
process.env.BUBBLE_DESKTOP_PROFILE = desktopDataProfile.profile;
process.env.BUBBLE_DESKTOP_USER_DATA = desktopDataProfile.userData;
process.env.BUBBLE_HOME = desktopDataProfile.agentHome;
process.env.BUBBLE_DEV = desktopDataProfile.profile === 'dev' ? '1' : '0';
app.setName(desktopDataProfile.appName);
app.setPath('userData', desktopDataProfile.userData);
console.log('[desktop:data]', desktopDataProfile);
