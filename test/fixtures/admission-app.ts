import {
  Global,
  Module,
  Controller,
  Get,
  Query,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  type ModuleMetadata,
  type Provider,
  type DynamicModule,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { createServer } from 'node:net';
import { HttpErrorFilter } from '../../src/core/presentation/http/filters/http-error.filter';
import {
  bindOperationContext,
  type HttpRequestLike,
} from '../../src/core/presentation/http/request-state';
import {
  AdmissionModule,
  type AdmissionRegistration,
} from '../../src/core/presentation/http/admission/admission.module';
import type { OperationSignals } from '../../src/core/application/observability/signal-contracts';

export const RECORDING_SIGNALS = Symbol.for(
  'foundation.test.admission-signals',
);

/** Registra atividades e contadores de saturação emitidos pelos sinais de admissão. */
export class RecordingSignals implements OperationSignals {
  readonly events: Array<{
    name: string;
    outcome: string;
    durationMs: number;
  }> = [];
  readonly saturations: Array<{
    name: string;
    attributes: Record<string, unknown>;
  }> = [];

  recordActivity(
    name: string,
    outcome: 'succeeded' | 'failed',
    durationMs: number,
  ): void {
    this.events.push({ name, outcome, durationMs });
  }

  recordSaturation(name: string, attributes?: Record<string, unknown>): void {
    this.saturations.push({ name, attributes: { ...attributes } });
  }

  async runActivity<T>(_request: unknown, work: () => Promise<T>): Promise<T> {
    return work();
  }

  injectTraceContext(): Record<string, string> {
    return {};
  }

  count(name: string): number {
    return this.events.filter((event) => event.name === name).length;
  }

  saturationCount(metric: string, reason: string): number {
    return this.saturations.filter(
      (event) => event.name === metric && event.attributes['reason'] === reason,
    ).length;
  }
}

/**
 * Guard de teste: não valida token. Quando `x-test-subject` existe, estabelece o
 * contexto autorizado como o guard real faria. O caminho real de autenticação é
 * coberto por `http-security.e2e-spec.ts`.
 */
export class FixtureIdentityGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<
      HttpRequestLike & {
        headers: Record<string, string | string[] | undefined>;
      }
    >();
    const subject = request.headers['x-test-subject'];
    const tenant = request.headers['x-test-tenant'];
    if (typeof subject === 'string')
      bindOperationContext(request, {
        correlationId: 'fixture',
        principal: {
          subjectId: subject,
          ...(typeof tenant === 'string' ? { tenantId: tenant } : {}),
          permissions: [],
        },
        deadlineAt: Date.now() + 30_000,
      });
    return true;
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

@Controller()
@UseGuards(FixtureIdentityGuard)
export class FixtureWorkController {
  /** Trabalho lento controlado pelo cliente (limitado a 5 s). */
  @Get('work')
  async work(@Query('ms') ms?: string): Promise<{ ok: true }> {
    const delay = Math.min(Math.max(Number(ms ?? 0) || 0, 0), 5_000);
    await sleep(delay);
    return { ok: true };
  }

  @Get('fast')
  fast(): { ok: true } {
    return { ok: true };
  }
}

export interface AdmissionAppOptions {
  readonly registration: AdmissionRegistration;
  readonly imports?: ModuleMetadata['imports'];
  /** Dependências visíveis ao AdmissionModule (global), ex.: checks e sinais de teste. */
  readonly providers?: Provider[];
}

/** Módulo global de fixture: expõe dependências de teste para o AdmissionModule. */
@Global()
@Module({})
class FixtureDependenciesModule {
  static with(providers: Provider[]): DynamicModule {
    const tokens = providers.map((provider) =>
      typeof provider === 'object' && 'provide' in provider
        ? provider.provide
        : provider,
    );
    return {
      module: FixtureDependenciesModule,
      providers,
      exports: tokens,
    };
  }
}

/** Cria a aplicação de teste com admissão registrada e escuta em porta efêmera. */
export async function createAdmissionTestApp(
  options: AdmissionAppOptions,
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      FixtureDependenciesModule.with(options.providers ?? []),
      AdmissionModule.register(options.registration),
      ...(options.imports ?? []),
    ],
    controllers: [FixtureWorkController],
    providers: [
      FixtureIdentityGuard,
      { provide: APP_FILTER, useClass: HttpErrorFilter },
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  return app;
}

export function startedRedisError(error: unknown): Error {
  const cause = error instanceof Error ? error.message : String(error);
  return new Error(
    `Docker did not respond to Testcontainers (Redis 7). Make sure the Docker daemon is running. Cause: ${cause}`,
  );
}

/** Porta livre do sistema, depois fechada: conexões nela são recusadas. */
export async function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
