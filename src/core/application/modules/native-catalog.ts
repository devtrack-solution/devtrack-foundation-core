import type { ModuleDescriptor } from './module-descriptor';

/**
 * Catálogo de descriptors das capacidades nativas. Metadata pura: não importa
 * Nest, não cria módulos e não lê configuração. O mapeamento para módulos Nest
 * fica na camada de infraestrutura do gerador de composição.
 */
export const NATIVE_MODULE_DESCRIPTORS: readonly ModuleDescriptor[] = [
  {
    id: 'native/opentelemetry',
    foundationApiMajor: 1,
    origin: { kind: 'native' },
    provides: [{ id: 'telemetry', major: 1 }],
    requires: [],
  },
  {
    id: 'native/aws-s3',
    foundationApiMajor: 1,
    origin: { kind: 'native' },
    provides: [{ id: 'object-storage', major: 1 }],
    requires: [],
  },
  {
    id: 'native/cache-redis',
    foundationApiMajor: 1,
    origin: { kind: 'native' },
    provides: [{ id: 'shared-rate-limit', major: 1 }],
    requires: [],
  },
  {
    id: 'native/queue-bullmq',
    foundationApiMajor: 1,
    origin: { kind: 'native' },
    // job-queue é a porta de submissão. requires:persistence: o ActivityStore usa o DataSource único.
    provides: [{ id: 'job-queue', major: 1 }],
    requires: [{ id: 'persistence', major: 1 }],
  },
  {
    id: 'native/persistence-typeorm',
    foundationApiMajor: 1,
    origin: { kind: 'native' },
    provides: [{ id: 'persistence', major: 1 }],
    requires: [],
  },
  {
    id: 'native/http-security',
    foundationApiMajor: 1,
    origin: { kind: 'native' },
    // authenticator é a capacidade explícita exigida por operações protegidas.
    provides: [
      { id: 'authenticator', major: 1 },
      { id: 'protected-routes', major: 1 },
    ],
    requires: [{ id: 'access-token', major: 1 }],
  },
];

export function findNativeDescriptor(id: string): ModuleDescriptor | undefined {
  return NATIVE_MODULE_DESCRIPTORS.find((descriptor) => descriptor.id === id);
}
