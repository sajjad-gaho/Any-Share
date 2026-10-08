import type { AuthProvider } from '../auth/auth-provider';
import type { TokenVerifier } from '../auth/token-verifier';
import { AuditService } from './audit-service';
import { AuthService, type AuthServiceOptions } from './auth-service';
import { ConnectionService } from './connection-service';
import type { ServiceDeps } from './context';
import { DevicesService } from './devices-service';
import { OrganizationsService } from './organizations-service';
import { PermissionsService } from './permissions-service';
import { SessionsService } from './sessions-service';
import { UsersService } from './users-service';

export interface Services {
  audit: AuditService;
  auth: AuthService;
  users: UsersService;
  organizations: OrganizationsService;
  permissions: PermissionsService;
  devices: DevicesService;
  sessions: SessionsService;
  connections: ConnectionService;
}

export function createServices(
  deps: ServiceDeps,
  auth: { provider: AuthProvider; verifier: TokenVerifier; options: AuthServiceOptions },
): Services {
  const audit = new AuditService(deps);
  const users = new UsersService(deps);
  const organizations = new OrganizationsService(deps);
  const permissions = new PermissionsService(deps, audit);
  const devices = new DevicesService(deps, audit, organizations, permissions);
  const sessions = new SessionsService(deps, audit, permissions);
  const connections = new ConnectionService(deps, audit, permissions, devices, sessions, users);
  return {
    audit,
    auth: new AuthService(deps, audit, auth.provider, auth.verifier, auth.options),
    users,
    organizations,
    permissions,
    devices,
    sessions,
    connections,
  };
}

export * from './audit-service';
export * from './auth-service';
export * from './connection-service';
export * from './context';
export * from './devices-service';
export * from './organizations-service';
export * from './permissions-service';
export * from './sessions-service';
export * from './users-service';
