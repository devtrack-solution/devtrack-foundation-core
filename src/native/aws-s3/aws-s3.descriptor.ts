import type { ModuleDescriptor } from '../../core/application/modules/module-descriptor';

/**
 * Descriptor de metadata do adapter S3 (para native-catalog.ts). Não importa Nest
 * nem o SDK. Provê object-storage major 1; não exige capacidades.
 */
export const AWS_S3_MODULE_ID = 'native/aws-s3';

export const AWS_S3_MODULE_DESCRIPTOR: ModuleDescriptor = {
  id: AWS_S3_MODULE_ID,
  foundationApiMajor: 1,
  origin: { kind: 'native' },
  provides: [{ id: 'object-storage', major: 1 }],
  requires: [],
};
