import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { options } from '../esbuild.config.mjs';

const result = await build({ ...options, write: false });
if (!Buffer.from(result.outputFiles[0].contents).equals(readFileSync('main.js'))) {
  throw new Error('main.js is out of date. Run npm run build and include the bundle.');
}
console.log('Committed bundle matches the source build.');
