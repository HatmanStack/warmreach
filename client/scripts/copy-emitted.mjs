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

for await (const tsPath of walk(path.join(root, 'src'))) {
  if (
    !tsPath.endsWith('.ts') ||
    tsPath.endsWith('.test.ts') ||
    tsPath.endsWith('.spec.ts')
  )
    continue;
  const rel = path.relative(root, tsPath);
  const jsRel = rel.replace(/\.ts$/, '.js');
  const src = path.join(emittedRoot, jsRel);
  const dst = path.join(root, jsRel);
  try {
    await stat(src);
  } catch {
    continue;
  }
  await mkdir(path.dirname(dst), { recursive: true });
  await copyFile(src, dst);
}
