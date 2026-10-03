// Uses the actual application, file IPC and isolated desktop/Agent profiles.
process.env.QA_MARKDOWN = '1';
process.env.QA_MARKDOWN_MEDIA = '1';
await import('./workspace-header-restore-electron.test.mjs');
