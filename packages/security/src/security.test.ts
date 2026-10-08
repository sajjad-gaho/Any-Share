import { ROLES } from '@remote-desktop/shared';
import { describe, expect, it } from 'vitest';
import { findDebugSwitch } from './launch';
import { isAllowedNavigation, isSafeExternalUrl } from './navigation';
import {
  ROLE_CAPABILITIES,
  ROLE_SESSION_CEILING,
  canManageMember,
  hasAllCapabilities,
  hasCapability,
  isRoleAtLeast,
} from './rbac';

describe('RBAC', () => {
  it('grants owners everything', () => {
    expect(hasCapability('owner', 'organization.delete')).toBe(true);
    expect(hasCapability('owner', 'audit.view')).toBe(true);
  });

  it('keeps admins from deleting the organisation', () => {
    expect(hasCapability('admin', 'organization.delete')).toBe(false);
    expect(hasCapability('admin', 'organization.manage_members')).toBe(true);
  });

  it('limits operators to viewing and connecting to devices', () => {
    expect(hasAllCapabilities('operator', ['device.view_all', 'device.connect'])).toBe(true);
    expect(hasCapability('operator', 'device.manage')).toBe(false);
    expect(hasCapability('operator', 'audit.view')).toBe(false);
  });

  it('gives plain users no organisation capabilities', () => {
    expect(ROLE_CAPABILITIES.user).toEqual([]);
    expect(ROLE_SESSION_CEILING.user).toEqual([]);
  });

  it('never grants a lower role more than a higher one', () => {
    for (let i = 1; i < ROLES.length; i++) {
      const higher = ROLES[i - 1] ?? 'owner';
      const lower = ROLES[i] ?? 'user';
      expect(ROLE_CAPABILITIES[lower].every((c) => ROLE_CAPABILITIES[higher].includes(c))).toBe(
        true,
      );
      expect(
        ROLE_SESSION_CEILING[lower].every((p) => ROLE_SESSION_CEILING[higher].includes(p)),
      ).toBe(true);
    }
  });

  it('orders roles', () => {
    expect(isRoleAtLeast('owner', 'admin')).toBe(true);
    expect(isRoleAtLeast('operator', 'admin')).toBe(false);
  });

  it('restricts who can manage which members', () => {
    expect(canManageMember('owner', 'admin', 'owner')).toBe(true);
    expect(canManageMember('admin', null, 'operator')).toBe(true);
    expect(canManageMember('admin', 'user', 'operator')).toBe(true);
    expect(canManageMember('admin', null, 'admin')).toBe(false);
    expect(canManageMember('admin', 'owner', null)).toBe(false);
    expect(canManageMember('operator', null, 'user')).toBe(false);
    expect(canManageMember('user', 'user', null)).toBe(false);
  });
});

describe('isAllowedNavigation', () => {
  it('allows same-origin navigation from the dev server', () => {
    expect(isAllowedNavigation('http://localhost:5173/#/devices', 'http://localhost:5173/')).toBe(
      true,
    );
  });

  it('blocks other origins', () => {
    expect(isAllowedNavigation('https://evil.example.com/', 'http://localhost:5173/')).toBe(false);
    expect(isAllowedNavigation('http://localhost:5174/', 'http://localhost:5173/')).toBe(false);
  });

  it('allows only the packaged index.html for file URLs', () => {
    const app = 'file:///C:/app/out/renderer/index.html';
    expect(isAllowedNavigation(`${app}#/settings`, app)).toBe(true);
    expect(isAllowedNavigation('file:///C:/Windows/System32/drivers/etc/hosts', app)).toBe(false);
    expect(isAllowedNavigation('https://example.com', app)).toBe(false);
  });

  it('rejects file URLs that point at another host (UNC / NTLM leak)', () => {
    const app = 'file:///C:/Program%20Files/Kestrel/resources/app.asar/out/renderer/index.html';
    const unc =
      'file://attacker.example/C:/Program%20Files/Kestrel/resources/app.asar/out/renderer/index.html';
    expect(isAllowedNavigation(unc, app)).toBe(false);
    expect(isAllowedNavigation('file://attacker.example/share/x.html', app)).toBe(false);
  });

  it('rejects garbage input', () => {
    expect(isAllowedNavigation('not a url', 'http://localhost:5173/')).toBe(false);
    expect(isAllowedNavigation('javascript:alert(1)', 'http://localhost:5173/')).toBe(false);
  });
});

describe('isSafeExternalUrl', () => {
  it('permits https and mailto only', () => {
    expect(isSafeExternalUrl('https://example.com')).toBe(true);
    expect(isSafeExternalUrl('mailto:support@example.com')).toBe(true);
    expect(isSafeExternalUrl('http://example.com')).toBe(false);
    expect(isSafeExternalUrl('file:///C:/Windows/notepad.exe')).toBe(false);
    expect(isSafeExternalUrl('ms-settings:')).toBe(false);
  });
});

describe('findDebugSwitch', () => {
  it('finds DevTools-protocol and inspector switches in any form', () => {
    expect(findDebugSwitch(['app.exe', '--remote-debugging-port=9222'])).toBe(
      'remote-debugging-port',
    );
    expect(findDebugSwitch(['app.exe', '--remote-debugging-pipe'])).toBe('remote-debugging-pipe');
    expect(findDebugSwitch(['app.exe', '--inspect'])).toBe('inspect');
    expect(findDebugSwitch(['app.exe', '--inspect-brk=0.0.0.0:9229'])).toBe('inspect-brk');
    expect(findDebugSwitch(['app.exe', '--REMOTE-DEBUGGING-PORT=1'])).toBe('remote-debugging-port');
  });

  it('ignores ordinary arguments', () => {
    expect(findDebugSwitch(['app.exe'])).toBeNull();
    expect(findDebugSwitch(['app.exe', '--allow-file-access-from-files=no', 'inspect'])).toBeNull();
    expect(findDebugSwitch(['app.exe', '--squirrel-firstrun', '--lang=en-US'])).toBeNull();
  });
});
