import { SetMetadata } from '@nestjs/common';

export const REQUIRED_PERMISSIONS_METADATA =
  'foundation.api.v1.required-permissions';

/** Declara permissões exigidas por rota ou controller. Sem declaração, só a autenticação é exigida. */
export const RequirePermissions = (...permissions: string[]) => {
  if (permissions.some((permission) => permission.length === 0))
    throw new Error('Required permissions must be non-empty strings');
  return SetMetadata(REQUIRED_PERMISSIONS_METADATA, permissions);
};
