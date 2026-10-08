// Bundles a Node service (apps/api, apps/signaling) into one ESM file.
// Workspace packages (@remote-desktop/*) are TypeScript sources and get bundled;
// npm dependencies stay external and are installed normally in production.
//
//   node ../../scripts/build-server.mjs <entry> <outfile>
import { build } from 'esbuild';

const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) {
  console.error('usage: build-server.mjs <entry> <outfile>');
  process.exit(1);
}

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  logLevel: 'info',
  plugins: [
    {
      name: 'externalize-npm-dependencies',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) =>
          args.path.startsWith('@remote-desktop/')
            ? undefined
            : { path: args.path, external: true },
        );
      },
    },
  ],
});
