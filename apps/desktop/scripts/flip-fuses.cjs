// Flips the Electron fuses of a packaged binary, then reads them back and fails
// the build if any fuse did not take. Runs in its own process (see after-pack.cjs).
//
//   node scripts/flip-fuses.cjs "<path to PBS AnyDesk.exe>"
const { FuseV1Options, FuseVersion, flipFuses, getCurrentFuseWire } = require('@electron/fuses');

/** Desired state; see electron-builder.yml and docs/security.md for the reasons. */
const FUSES = {
  // ELECTRON_RUN_AS_NODE would turn the app into a generic Node.js runtime.
  [FuseV1Options.RunAsNode]: false,
  // NODE_OPTIONS (--require, --inspect, ...) must not affect the app.
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  // --inspect / --inspect-brk: no Node inspector in production.
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  // Refuse to start if app.asar was modified after packaging.
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  // Load the app only from the integrity-checked app.asar.
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  // Encrypt cookies on disk with the OS key store.
  [FuseV1Options.EnableCookieEncryption]: true,
  // Must stay on while the renderer is loaded from file:// inside app.asar: with
  // it off, Electron 44 cannot read out/renderer/index.html (ERR_FILE_NOT_FOUND).
  // Turning it off needs a custom app:// protocol first (see docs/security.md).
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
};

async function main() {
  const exe = process.argv[2];
  if (!exe) throw new Error('usage: flip-fuses.cjs <electron binary>');
  await flipFuses(exe, { version: FuseVersion.V1, ...FUSES });

  const wire = await getCurrentFuseWire(exe);
  const ENABLE = 49; // '1'
  const failed = Object.entries(FUSES).filter(
    ([option, wanted]) => (wire[option] === ENABLE) !== wanted,
  );
  if (failed.length > 0) {
    throw new Error(`Fuses not applied: ${failed.map(([o]) => FuseV1Options[o] ?? o).join(', ')}`);
  }
  console.log(`  • electron fuses applied and verified (${Object.keys(FUSES).length})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
