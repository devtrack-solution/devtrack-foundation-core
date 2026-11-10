// Processo worker real para os testes de kill e drenagem. Executado com
// `node -r ts-node/register/transpile-only test/fixtures/worker-child.ts`.
import { Pool } from 'pg';
import { runWorkerProcess } from '../../src/worker';
import { createFixtureHandlers, fixtureIdentity } from './worker-fixtures';

const pool = new Pool({
  host: process.env.FOUNDATION_DB_HOST,
  port: Number(process.env.FOUNDATION_DB_PORT),
  database: process.env.FOUNDATION_DB_NAME,
  user: process.env.FOUNDATION_DB_USER,
  password: process.env.FOUNDATION_DB_PASSWORD,
  max: 3,
});

runWorkerProcess({
  env: process.env,
  handlers: createFixtureHandlers(pool),
  identity: fixtureIdentity,
}).catch(() => {
  process.exit(1);
});
