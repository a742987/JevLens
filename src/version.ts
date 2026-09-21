import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readVersion(): string {
  for (const candidate of [join(import.meta.dirname, '..', 'package.json'), join(import.meta.dirname, 'package.json')]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'jevlens' && typeof pkg.version === 'string') return pkg.version;
    } catch {
      /* try the next candidate */
    }
  }
  return '0.0.0-dev';
}

export const VERSION: string = readVersion();
