// Checks the public configuration a packaged build is compiled with, using the
// same sources and precedence as electron-vite (production mode):
// .env, .env.local, .env.production, .env.production.local, then MAIN_VITE_*
// variables from the environment.
//
// A release build must talk to HTTPS/WSS servers; a LAN test build (plain
// http/ws) must never be shipped. Local test packaging can opt out with
// KESTREL_LOCAL_PACKAGE=1, which is reported loudly.
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

function parseEnvFile(path) {
  const values = {};
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith('#')) continue;
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

function loadBuildEnv(appDir, env = process.env) {
  const files = ['.env', '.env.local', '.env.production', '.env.production.local'];
  const merged = Object.assign({}, ...files.map((f) => parseEnvFile(join(appDir, f))));
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('MAIN_VITE_') && value !== undefined) merged[key] = value;
  }
  return merged;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Returns a list of problems (empty = releasable). */
function releaseProblems(config) {
  const problems = [];
  const check = (name, protocol) => {
    const value = config[name];
    if (!value) return problems.push(`${name} is not set`);
    let url;
    try {
      url = new URL(value);
    } catch {
      return problems.push(`${name} is not a valid URL`);
    }
    if (url.protocol !== protocol) problems.push(`${name} must use ${protocol}//`);
    if (LOOPBACK.has(url.hostname))
      problems.push(`${name} points at this machine (${url.hostname})`);
  };
  check('MAIN_VITE_API_URL', 'https:');
  check('MAIN_VITE_SIGNALING_URL', 'wss:');
  if (config.MAIN_VITE_ALLOW_LAN_HTTP === 'true') {
    problems.push('MAIN_VITE_ALLOW_LAN_HTTP=true (LAN test builds must not be released)');
  }
  return problems;
}

module.exports = { loadBuildEnv, releaseProblems };
