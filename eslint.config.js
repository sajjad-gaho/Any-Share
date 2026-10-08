// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const NODE_ONLY_MODULES = [
  'electron',
  'electron/*',
  'node:*',
  'fs',
  'fs/*',
  'child_process',
  'path',
  'os',
  'process',
  'net',
  'http',
  'https',
  'crypto',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      '**/release/**',
      '**/coverage/**',
      '**/.turbo/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: [
      'apps/desktop/src/main/**/*.ts',
      'apps/desktop/src/preload/**/*.ts',
      'apps/api/**/*.ts',
      'apps/signaling/**/*.ts',
      'packages/backend/**/*.ts',
      'scripts/**/*.{js,mjs}',
      '**/*.config.{js,ts}',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    // CommonJS build hooks (electron-builder loads them with require()).
    files: ['**/*.cjs'],
    languageOptions: { globals: globals.node, sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Server-only code (database access, auth provider, config with secrets)
    // must never be bundled into the Electron app or the shared packages.
    files: ['apps/desktop/**/*.{ts,tsx}', 'packages/{shared,security,webrtc,ui}/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@remote-desktop/backend', '@remote-desktop/backend/*'],
              message:
                'Server-only package. The desktop app talks to the backend over HTTP via the main process.',
            },
          ],
        },
      ],
    },
  },
  {
    // Security boundary: the renderer is untrusted web content. It may only reach
    // privileged functionality through the typed `window.desktop` IPC bridge.
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@remote-desktop/backend', '@remote-desktop/backend/*'],
              message:
                'Server-only package. The desktop app talks to the backend over HTTP via the main process.',
            },
            {
              group: NODE_ONLY_MODULES,
              message:
                'The renderer must not import Node.js or Electron modules. Use the window.desktop IPC bridge instead.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'require', message: 'require is not available in the sandboxed renderer.' },
        { name: 'process', message: 'process is not available in the sandboxed renderer.' },
      ],
    },
  },
  prettier,
);
