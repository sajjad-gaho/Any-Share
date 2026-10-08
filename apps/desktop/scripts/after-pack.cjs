// electron-builder afterPack hook:
//  1. refuses to package a build whose public configuration is not releasable
//     (see release-config.cjs), unless KESTREL_LOCAL_PACKAGE=1;
//  2. applies the Electron fuses.
//
// electron-builder's own `electronFuses` option flips the fuses in-process,
// which on Windows left the binary open and made the final rename of
// `win-unpacked.tmp` fail with EPERM. Flipping in a child process closes every
// handle before electron-builder continues (signing, then the rename).
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { loadBuildEnv, releaseProblems } = require('./release-config.cjs');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') {
    throw new Error('Only Windows packaging is configured; add fuse handling for this platform');
  }

  const appDir = join(__dirname, '..');
  const problems = releaseProblems(loadBuildEnv(appDir));
  if (problems.length > 0) {
    if (process.env.KESTREL_LOCAL_PACKAGE === '1') {
      console.warn(
        `  ⚠ LOCAL TEST PACKAGE (KESTREL_LOCAL_PACKAGE=1), NOT RELEASABLE:\n    - ${problems.join('\n    - ')}`,
      );
    } else {
      throw new Error(
        `Refusing to package a release build:\n  - ${problems.join('\n  - ')}\n` +
          'Set MAIN_VITE_API_URL (https://) and MAIN_VITE_SIGNALING_URL (wss://) in ' +
          'apps/desktop/.env.production, or KESTREL_LOCAL_PACKAGE=1 for a local test package.',
      );
    }
  }

  const exe = join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  execFileSync(process.execPath, [join(__dirname, 'flip-fuses.cjs'), exe], {
    stdio: 'inherit',
    cwd: appDir,
  });
};
