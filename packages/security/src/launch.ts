/**
 * Command-line switches that hand control of the app to another process: the
 * Chromium DevTools protocol (`--remote-debugging-*`) and the Node inspector
 * (`--inspect*`). A packaged build must refuse to start with any of them,
 * otherwise anything running as the same Windows user could drive the app
 * (start sessions, read the signed-in user's data) without the user noticing.
 */
const DEBUG_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-pipe',
  'remote-debugging-address',
  'remote-allow-origins',
  'inspect',
  'inspect-brk',
  'inspect-port',
  'inspect-publish-uid',
  'debug',
  'debug-brk',
];

/** Returns the first debugging switch in `argv` (e.g. `--inspect=9229`), or null. */
export function findDebugSwitch(argv: readonly string[]): string | null {
  for (const arg of argv) {
    const match = /^--?([a-z-]+)(?:=.*)?$/i.exec(arg.trim());
    const name = match?.[1]?.toLowerCase();
    if (name && DEBUG_SWITCHES.includes(name)) return name;
  }
  return null;
}
