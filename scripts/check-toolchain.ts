import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const expectedNode = 'v22.14.0';
const expectedPnpm = '11.25.0';

if (process.version !== expectedNode) {
  throw new Error(`Node version mismatch: expected ${expectedNode}, received ${process.version}`);
}

const pnpmEntryPoint = resolve('node_modules/pnpm/bin/pnpm.cjs');
const actualPnpm = execFileSync(process.execPath, [pnpmEntryPoint, '--version'], {
  encoding: 'utf8',
}).trim();
if (actualPnpm !== expectedPnpm) {
  throw new Error(`pnpm version mismatch: expected ${expectedPnpm}, received ${actualPnpm}`);
}

console.log(
  JSON.stringify({ event: 'toolchain.verified', node: expectedNode, pnpm: expectedPnpm }),
);
