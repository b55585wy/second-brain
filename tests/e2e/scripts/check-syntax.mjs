import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
async function modules(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.npm-cache', 'artifacts'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await modules(path));
    else if (entry.name.endsWith('.mjs')) files.push(path);
  }
  return files;
}
JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const files = await modules(root);
for (const path of files) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`${path}\n${result.stderr || result.error?.message}`);
}
console.log(`Syntax valid: ${files.length} E2E .mjs files and package.json. No server/browser contacted.`);
