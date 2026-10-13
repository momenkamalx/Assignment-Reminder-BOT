import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}
/** Resolve existing ancestors too, so a symlink cannot place credentials inside Git. */
export async function externalAuthPath(path: string, root = process.cwd()): Promise<string> {
  const target = resolve(path);
  if (inside(resolve(root), target)) throw new Error('Authentication must be stored outside the project directory.');
  let ancestor = target;
  let actual: string;
  for (;;) {
    try { actual = await realpath(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
      ancestor = dirname(ancestor);
    }
  }
  const canonical = join(actual, relative(ancestor, target));
  if (inside(await realpath(root), canonical)) throw new Error('Authentication must be stored outside the project directory.');
  return canonical;
}
