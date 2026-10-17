import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
const { source } = JSON.parse(await readFile(new URL('../capability.json', import.meta.url), 'utf8'));
await build({ entryPoints: ['src/main.ts'], bundle: true, platform: 'node', target: 'node24', format: 'cjs', outfile: 'dist/index.cjs', define: { FLASHDATA_SOURCE: JSON.stringify(source) }, legalComments: 'inline' });
