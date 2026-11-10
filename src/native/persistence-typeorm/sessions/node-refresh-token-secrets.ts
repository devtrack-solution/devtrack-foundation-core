import { createHash, randomBytes } from 'node:crypto';
import type { RefreshTokenSecrets } from '../../../core/application/security/authentication.ports';

/** 256 bits aleatórios em base64url; digest SHA-256 em hexadecimal. */
export const NODE_REFRESH_TOKEN_SECRETS: RefreshTokenSecrets = {
  generate: () => randomBytes(32).toString('base64url'),
  digest: (value: string) =>
    createHash('sha256').update(value, 'utf8').digest('hex'),
};
