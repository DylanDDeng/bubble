process.env.QA_BOARD_SIDEBAR = '1';
process.env.QA_SIDEBAR_MOTION = '1';
await import('./workspace-header-restore-electron.test.mjs');
