import { readdir, copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const root = process.cwd();
const emittedRoot = path.join(root, 'build-tsc');

// Map TS-source extensions to the emitted JS output extensions that tsc
// produces under "module": "NodeNext":
//   .ts  → .js  (ESM, matches package "type": "module")
//   .cts → .cjs (CommonJS — used for Electron sandboxed preloads)
//   .mts → .mjs (explicit ESM)
const TS_TO_JS = [
  ['.test.ts', null],
  ['.spec.ts', null],
  ['.cts', '.cjs'],
  ['.mts', '.mjs'],
  ['.ts', '.js'],
];

function emittedNameFor(tsPath) {
  for (const [suffix, replacement] of TS_TO_JS) {
    if (tsPath.endsWith(suffix)) {
      if (replacement === null) return null;
      return tsPath.slice(0, -suffix.length) + replacement;
    }
  }
  return null;
}

for await (const tsPath of walk(path.join(root, 'src'))) {
  const jsAbs = emittedNameFor(tsPath);
  if (!jsAbs) continue;
  const rel = path.relative(root, jsAbs);
  const src = path.join(emittedRoot, rel);
  const dst = path.join(root, rel);
  try {
    await stat(src);
  } catch {
    continue;
  }
  await mkdir(path.dirname(dst), { recursive: true });
  await copyFile(src, dst);
}
