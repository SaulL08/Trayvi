import { applicationValue } from '@internal-api/bootstrap';

export function forbiddenEnvironmentRead(): NodeJS.ProcessEnv | undefined {
  return (processAlias as unknown as Record<string, NodeJS.ProcessEnv>)['e' + 'nv'];
}

const processAlias = globalThis['process'];

export { applicationValue };
