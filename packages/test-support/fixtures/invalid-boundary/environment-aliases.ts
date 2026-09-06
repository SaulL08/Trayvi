const processAlias = globalThis.process;
const secondAlias = processAlias;
const { env: environmentAlias } = secondAlias;

export const forbiddenEnvironment = environmentAlias.NODE_ENV;
