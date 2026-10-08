import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { ConfigError, loadConfig, loadEnvFiles, type ServerConfig } from './config';

/** The monorepo root (the directory holding pnpm-workspace.yaml), if any. */
function findWorkspaceRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Loads configuration for a server entry point from the environment, then
 * `.env.<APP_ENV>.local` / `.env.<APP_ENV>` / `.env` in the app directory and
 * the repository root. A bad configuration exits with the list of problems
 * (variable names only, never values) instead of a stack trace.
 */
export function loadConfigOrExit(cwd: string = process.cwd()): ServerConfig {
  try {
    let env: Record<string, string | undefined> = loadEnvFiles(cwd);
    const root = findWorkspaceRoot(cwd);
    if (root && root !== resolve(cwd)) env = loadEnvFiles(root, env);
    const config = loadConfig(env);
    // Relative file paths: the app directory first, then the repository root.
    const caFile = config.database.sslCaFile;
    if (caFile && !isAbsolute(caFile)) {
      const candidates = [resolve(cwd, caFile), ...(root ? [resolve(root, caFile)] : [])];
      config.database.sslCaFile = candidates.find((path) => existsSync(path)) ?? candidates[0];
    }
    return config;
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
