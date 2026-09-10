import { applicationValue } from '@internal-api/bootstrap';

export function forbiddenEnvironmentRead(): NodeJS.ProcessEnv | undefined {
  return (processAlias as unknown as Record<string, NodeJS.ProcessEnv>)['e' + 'nv'];
}

const processAlias = globalThis['process'];
const reflectedProcess = Reflect.get(globalThis, 'process');
const applicationRoot = '@internal-api';
const applicationTarget = `${applicationRoot}/bootstrap`;

export { applicationValue };
export const forbiddenReflectedEnvironment = reflectedProcess.env.NODE_ENV;
export const forbiddenStaticDynamicImport = import(applicationTarget);
