import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

await mkdir('dist/src', { recursive: true });
await build({ entryPoints: ['src/main.js'], bundle: true, format: 'esm', platform: 'browser', target: ['chrome110'], outfile: 'dist/src/main.js', sourcemap: false, minify: true });
await Promise.all([
  copyFile('index.html', 'dist/index.html'),
  copyFile('src/styles.css', 'dist/src/styles.css'),
  copyFile('notification-worker.js', 'dist/notification-worker.js'),
]);
