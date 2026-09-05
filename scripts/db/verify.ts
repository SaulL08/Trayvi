import { loadMigrationConfig } from '../../packages/config/src/index.js';
import { runDatabaseVerification } from './verification.js';

async function main(): Promise<void> {
  const config = loadMigrationConfig();
  const evidence = await runDatabaseVerification(config.databaseUrl);
  const passed = Object.values(evidence).every(Boolean);
  process.stdout.write(`${JSON.stringify({ event: 'database.verification', passed, evidence })}\n`);
  if (!passed) process.exitCode = 1;
}

void main().catch(() => {
  process.stderr.write('{"event":"database.verification.failed","outcome":"failed"}\n');
  process.exitCode = 1;
});
