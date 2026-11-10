import { Module } from '@nestjs/common';
import type {
  DynamicModule,
  InjectionToken,
  ModuleMetadata,
} from '@nestjs/common';
import { S3ObjectStorage } from './aws-s3.adapter';
import { resolveAwsS3Options } from './aws-s3.options';
import type { AwsS3Options } from './aws-s3.options';

/**
 * Token do ObjectStorage nativo. Passe-o ao módulo que consome a porta
 * (ex.: ContactsModule.register({ media: { storage: { token } } })).
 */
export const AWS_S3_OBJECT_STORAGE: InjectionToken = Symbol.for(
  'foundation.api.v1.native.aws-s3.object-storage',
);

export interface AwsS3AsyncOptions {
  readonly imports?: ModuleMetadata['imports'];
  readonly inject?: readonly InjectionToken[];
  /** Devolve a configuração (ex.: lida de um cofre). Falha de validação impede o boot. */
  readonly useFactory: (
    ...args: unknown[]
  ) => AwsS3Options | Promise<AwsS3Options>;
}

/**
 * Módulo nativo de object storage em S3. Só entra no grafo se o host importá-lo.
 * Configuração inválida lança em register/registerAsync, antes de o Nest iniciar.
 */
@Module({})
export class AwsS3Module {
  static register(options: AwsS3Options): DynamicModule {
    const storage = new S3ObjectStorage(resolveAwsS3Options(options));
    return {
      module: AwsS3Module,
      providers: [{ provide: AWS_S3_OBJECT_STORAGE, useValue: storage }],
      exports: [AWS_S3_OBJECT_STORAGE],
    };
  }

  static registerAsync(options: AwsS3AsyncOptions): DynamicModule {
    if (typeof options?.useFactory !== 'function')
      throw new Error('Invalid AWS S3 registration: useFactory');
    return {
      module: AwsS3Module,
      imports: options.imports,
      providers: [
        {
          provide: AWS_S3_OBJECT_STORAGE,
          inject: [...(options.inject ?? [])],
          useFactory: async (...args: unknown[]) =>
            new S3ObjectStorage(
              resolveAwsS3Options(await options.useFactory(...args)),
            ),
        },
      ],
      exports: [AWS_S3_OBJECT_STORAGE],
    };
  }
}
