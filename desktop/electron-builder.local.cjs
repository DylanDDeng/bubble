// Local dogfood artifacts only. No feed, upload, signing account or notarization.
// package-local.mjs targets the host architecture. Keep native fallbacks for
// that target only; never remove the selected prebuild or PTY spawn-helper.
const otherNativeTargets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64',
  'linuxmusl-arm64', 'linuxmusl-x64', 'win32-arm64', 'win32-x64']
  .filter(target => target !== `darwin-${process.arch}`);

module.exports = {
  appId: 'ai.bubblebrain.desktop',
  productName: 'Bubble',
  directories: { output: 'out/dogfood', buildResources: 'build' },
  electronDist: 'node_modules/electron/dist',
  npmRebuild: false,
  asar: true,
  // These declarations are runtime inputs for tsserver, not development-only
  // typings. electron-builder normally drops every .d.ts in node_modules.
  onNodeModuleFile: file => /\/node_modules\/typescript\/lib\/[^/]+\.d\.ts$/.test(file.replace(/\\/g, '/')),
  files: [
    'package.json',
    'dist-electron/**/*',
    'dist-react/**/*',
    'runtime/bubble/package.json',
    'runtime/bubble/dist/**/*',
    'appearance-reference.json',
    'build/skins/aegis-reference.png',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    '!**/__tests__/**',
    '!**/*.test.*',
    '!**/*.map',
    '!dist-electron/**/*.d.ts',
    '!runtime/bubble/dist/**/*.d.ts',
    '!node_modules/better-sqlite3/src/**/*',
    '!node_modules/better-sqlite3/deps/**/*',
    '!node_modules/node-pty/src/**/*',
    '!node_modules/node-pty/deps/**/*',
    '!node_modules/node-pty/third_party/**/*',
    '!node_modules/node-pty/scripts/**/*',
    '!node_modules/@bubblebrain-ai/pi-tui/native/win32/**/*',
    '!node_modules/@bubblebrain-ai/pi-tui/native/darwin/src/**/*',
    ...otherNativeTargets.flatMap(target => [
      `!node_modules/better-sqlite3/prebuilds/${target}.node`,
      `!node_modules/node-pty/prebuilds/${target}/**/*`,
      `!node_modules/@bubblebrain-ai/pi-tui/native/darwin/prebuilds/${target}/**/*`,
    ]),
  ],
  asarUnpack: ['node_modules/node-pty/**/*', '**/*.node'],
  extraResources: [{ from: 'dist-electron/electron/preload.cjs', to: 'preload.cjs' }],
  protocols: [{ name: 'Bubble session links', schemes: ['bubble-desktop'] }],
  publish: null,
  mac: {
    target: 'dmg',
    category: 'public.app-category.developer-tools',
    icon: 'build/bubble-icon.icns',
    identity: '-',
    hardenedRuntime: false,
    notarize: false,
    artifactName: 'Bubble-${version}-${arch}-dogfood.${ext}',
  },
  dmg: {
    title: 'Bubble',
    contents: [
      { x: 140, y: 150 },
      { x: 420, y: 150, type: 'link', path: '/Applications' },
    ],
  },
};
