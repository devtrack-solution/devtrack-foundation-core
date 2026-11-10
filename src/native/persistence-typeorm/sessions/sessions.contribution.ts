import type { PersistenceModuleContribution } from '../persistence-catalog';
import { AuthRefreshTokenOrmEntity } from './auth-refresh-token.orm-entity';
import { AuthSessionOrmEntity } from './auth-session.orm-entity';
import { CreateAuthSessions1794345600000 } from './create-auth-sessions.migration';

/**
 * Contribuição de sessões e refresh tokens para o catálogo de persistência. O
 * integrador a inclui em `PERSISTENCE_CONTRIBUTIONS` do host (runtime e CLI).
 */
export const SESSIONS_PERSISTENCE: PersistenceModuleContribution = {
  moduleId: 'foundation/sessions',
  entities: [AuthSessionOrmEntity, AuthRefreshTokenOrmEntity],
  migrations: [CreateAuthSessions1794345600000],
};
