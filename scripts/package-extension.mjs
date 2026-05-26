import { ZipArchive } from 'archiver';
import { createWriteStream, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
const name = `avenue-${manifest.version}.zip`;
const outDir = resolve(root, 'dist');
const outPath = resolve(outDir, name);
const packageEntries = [
  'background.js',
  'background/command-helpers.js',
  'background/storage-helpers.js',
  'gen-icons.js',
  'manifest.json',
  'README.md',
  'icons',
  'sidepanel/index.css',
  'sidepanel/index.html',
  'sidepanel/index.js',
  'sidepanel/drag-helpers.js',
  'sidepanel/settings-panel.js',
  'sidepanel/dom-utils.js',
  'sidepanel/icons.js',
  'sidepanel/state-helpers.js',
  'docs',
  'CHANGELOG.md',
];

mkdirSync(outDir, { recursive: true });
rmSync(outPath, { force: true });

const output = createWriteStream(outPath);
const archive = new ZipArchive({ zlib: { level: 9 } });
const done = new Promise((resolveDone, rejectDone) => {
  output.on('close', resolveDone);
  archive.on('warning', rejectDone);
  archive.on('error', rejectDone);
});

archive.pipe(output);

for (const entry of packageEntries) {
  const absolutePath = resolve(root, entry);
  if (entry.includes('.') && !entry.endsWith('.md')) {
    archive.file(absolutePath, { name: entry });
  } else if (entry === 'README.md' || entry === 'CHANGELOG.md' || entry === 'manifest.json' || entry === 'background.js' || entry === 'gen-icons.js') {
    archive.file(absolutePath, { name: entry });
  } else {
    archive.directory(absolutePath, entry);
  }
}

await archive.finalize();
await done;

console.log(outPath);
