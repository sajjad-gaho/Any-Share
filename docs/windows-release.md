# Windows release build

## Build

```bash
pnpm --filter @remote-desktop/windows-helper build          # kestrel-helper.exe
# apps/desktop/.env.production (public values only, git-ignored):
#   MAIN_VITE_API_URL=https://api.<domain>
#   MAIN_VITE_SIGNALING_URL=wss://signal.<domain>/ws
pnpm --filter @remote-desktop/desktop package:win           # release/Kestrel Remote-Setup-<version>-x64.exe
```

`scripts/after-pack.cjs` runs inside electron-builder and:

1. **Refuses** to package unless the API URL is `https://`, the signaling URL is
   `wss://`, neither points at this machine, and the LAN test switch
   (`MAIN_VITE_ALLOW_LAN_HTTP`) is off. `KESTREL_LOCAL_PACKAGE=1` allows a
   local test package and prints a "NOT RELEASABLE" warning.
2. Applies and verifies the Electron fuses (docs/security.md).

The packaged app also refuses to start with `--remote-debugging-*` or
`--inspect*`, has no application menu or DevTools, and shows no sample data.

Known build issue (this machine): Windows Defender scans the freshly extracted
Electron archive, and electron-builder's immediate rename of
`release/win-unpacked.tmp` fails with `EPERM`. Workaround: package from the
already-downloaded, checksum-verified Electron of the same version, which is
copied instead of extracted (no rename):

```bash
npx electron-builder --win --config.electronDist=node_modules/electron/dist
```

Check first that `node_modules/electron/dist/version` matches the `electron`
version in package.json.

## Checklist before a public release

| Item                                   | Status                                           |
| -------------------------------------- | ------------------------------------------------ |
| Production URLs (https/wss)            | Enforced by the release guard                    |
| Fuses, debug-switch guard, no DevTools | Done, verified on a packaged build               |
| Native helper bundled                  | Done (`resources/kestrel-helper.exe`)            |
| Product name, publisher, appId         | **Placeholder** (Kestrel Remote, com.example)    |
| Icon (`build/icon.ico`)                | **Missing**: default Electron icon               |
| Code signing                           | **Not implemented: requires a certificate**      |
| Auto-update                            | **Not implemented** (needs signing + HTTPS feed) |

## Code signing (requires a certificate)

Windows SmartScreen warns about unsigned installers, and an update mechanism
must not install unsigned payloads. Options (configured in `electron-builder.yml`,
commented out until a certificate exists):

- **Azure Trusted Signing (Artifact Signing)**: `win.azureSignOptions`
  (publisherName, endpoint, certificateProfileName, codeSigningAccountName);
  the key never leaves Azure. Recommended.
- **OV/EV certificate on an HSM or hardware token**: `win.signtoolOptions` with
  an RFC 3161 timestamp server.

Sign both the app executable and the installer; timestamp every signature.
Never commit a `.pfx` or put a private key file in CI variables.

## Auto-update (design; not implemented)

Planned, once signing exists:

- `electron-updater` with a `generic` HTTPS provider (e.g. `https://updates.<domain>/`)
  serving `latest.yml` + the signed installer from object storage behind TLS.
- electron-updater on Windows verifies that the downloaded installer is
  Authenticode-signed by the configured `publisherName` before running it;
  `latest.yml` also pins the SHA-512 of the file.
- Check on start-up and every few hours; download in the background; install
  only after the user agrees (no forced restart during a session). Never
  install while a remote session is active.
- Staged rollout by publishing to a `beta` channel first; rollback by
  re-publishing the previous version with a higher build number.
- Failure handling: a failed download or signature check is logged and the
  current version keeps running.

Implementing this without a signing certificate would allow installing
unsigned payloads, so it is deliberately not implemented yet.
