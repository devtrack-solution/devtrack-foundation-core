import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Post,
  UseGuards,
  type DynamicModule,
  type INestApplication,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { OperationContext } from '../../src/core/application/context/operation-context';
import { OPERATION_CONTEXT_ACCESSOR } from '../../src/core/application/context/operation-context.accessor';
import { IdempotencyService } from '../../src/core/application/idempotency/idempotency.service';
import { InMemoryIdempotencyStore } from '../../src/core/application/idempotency/in-memory-idempotency.store';
import { IDEMPOTENCY_SERVICE } from '../../src/core/application/idempotency/idempotency.types';
import type { IdentityAccessResolver } from '../../src/core/application/security/authentication.ports';
import { AuthenticationError } from '../../src/core/application/security/authentication.service';
import {
  AuthorizationError,
  OPERATION_AUTHORIZER,
  type OperationAuthorizationRequest,
  type OperationAuthorizer,
} from '../../src/core/application/security/operation-authorizer';
import { AsyncOperationContextStore } from '../../src/core/infrastructure/context/async-operation-context.store';
import { AuthenticationGuard } from '../../src/core/presentation/http/guards/authentication.guard';
import { RequirePermissions } from '../../src/core/presentation/http/decorators/require-permissions.decorator';
import { HttpErrorFilter } from '../../src/core/presentation/http/filters/http-error.filter';
import { OperationContextInterceptor } from '../../src/core/presentation/http/interceptors/operation-context.interceptor';
import {
  Idempotent,
  IDEMPOTENCY_IDENTITY_RESOLVER,
  NODE_IDEMPOTENCY_CRYPTO,
} from '../../src/core/presentation/http/idempotency';
import { IdempotencyInterceptor } from '../../src/core/presentation/http/idempotency/idempotency.interceptor';

export const FIXTURE_STATE = Symbol.for(
  'foundation.test.idempotency-fixture.state',
);

export interface FixturePrincipal {
  readonly tenantId: string;
  permissions: string[];
}

export interface FixtureState {
  readonly principals: Map<string, FixturePrincipal>;
  readonly tokens: Map<string, string>;
  executions: number;
  gate: Promise<void>;
  openGate: () => void;
}

export function createFixtureState(): FixtureState {
  let openGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  return {
    principals: new Map<string, FixturePrincipal>([
      ['subject-a', { tenantId: 't1', permissions: ['contacts:write'] }],
      ['subject-b', { tenantId: 't1', permissions: ['contacts:write'] }],
      ['subject-x', { tenantId: 't2', permissions: ['contacts:write'] }],
    ]),
    tokens: new Map<string, string>([
      ['token-a', 'subject-a'],
      ['token-b', 'subject-b'],
      ['token-x', 'subject-x'],
    ]),
    executions: 0,
    gate,
    openGate,
  };
}

/** Dublê de autenticação: token -> contexto com permissões atuais do estado. */
function fixtureAuthorizer(state: FixtureState): OperationAuthorizer {
  const authorize = (
    request: OperationAuthorizationRequest,
  ): Promise<OperationContext> => {
    const subjectId =
      request.bearerToken === undefined
        ? undefined
        : state.tokens.get(request.bearerToken);
    const principal =
      subjectId === undefined ? undefined : state.principals.get(subjectId);
    if (subjectId === undefined || principal === undefined)
      return Promise.reject(new AuthenticationError('invalid_credentials'));
    if (
      !request.requiredPermissions.every((item) =>
        principal.permissions.includes(item),
      )
    )
      return Promise.reject(new AuthorizationError());
    return Promise.resolve({
      correlationId: request.correlationId,
      principal: {
        subjectId,
        tenantId: principal.tenantId,
        permissions: [...principal.permissions],
      },
      deadlineAt: Date.now() + 30_000,
    });
  };
  return { authorize } as unknown as OperationAuthorizer;
}

/** Dublê do IdentityAccessResolver: reflete revogações feitas no estado. */
@Injectable()
class FixtureIdentities implements IdentityAccessResolver {
  constructor(@Inject(FIXTURE_STATE) private readonly state: FixtureState) {}

  bySubject(subjectId: string) {
    const principal = this.state.principals.get(subjectId);
    if (principal === undefined) return Promise.resolve(null);
    return Promise.resolve({
      subjectId,
      tenantId: principal.tenantId,
      permissions: [...principal.permissions],
    });
  }

  byExternalIdentity(): Promise<null> {
    return Promise.resolve(null);
  }
}

@Controller('fixture')
class FixtureController {
  constructor(@Inject(FIXTURE_STATE) private readonly state: FixtureState) {}

  @Post('contacts')
  @UseGuards(AuthenticationGuard)
  @RequirePermissions('contacts:write')
  @Idempotent({ operationId: 'contacts.create', retentionMs: 60_000 })
  create(@Body() body: { name?: string }) {
    if (typeof body?.name !== 'string')
      throw new BadRequestException('name_required');
    this.state.executions += 1;
    return { id: `c-${this.state.executions}`, name: body.name };
  }

  @Post('accepted')
  @HttpCode(202)
  @UseGuards(AuthenticationGuard)
  @RequirePermissions('contacts:write')
  @Idempotent({ operationId: 'contacts.accept', retentionMs: 60_000 })
  accept(@Body() body: { name?: string }) {
    this.state.executions += 1;
    return { accepted: true, name: body?.name ?? null };
  }

  @Post('flaky')
  @UseGuards(AuthenticationGuard)
  @RequirePermissions('contacts:write')
  @Idempotent({ operationId: 'contacts.flaky', retentionMs: 60_000 })
  flaky(): never {
    this.state.executions += 1;
    throw new Error('upstream reset');
  }

  @Post('slow')
  @UseGuards(AuthenticationGuard)
  @RequirePermissions('contacts:write')
  @Idempotent({ operationId: 'contacts.slow', retentionMs: 60_000 })
  async slow(): Promise<{ done: true }> {
    this.state.executions += 1;
    await this.state.gate;
    return { done: true };
  }
}

@Module({})
class FixtureModule {
  static register(state: FixtureState): DynamicModule {
    return {
      module: FixtureModule,
      controllers: [FixtureController],
      providers: [
        { provide: FIXTURE_STATE, useValue: state },
        {
          provide: OPERATION_AUTHORIZER,
          useFactory: fixtureAuthorizer,
          inject: [FIXTURE_STATE],
        },
        { provide: IDEMPOTENCY_IDENTITY_RESOLVER, useClass: FixtureIdentities },
        AsyncOperationContextStore,
        {
          provide: OPERATION_CONTEXT_ACCESSOR,
          useExisting: AsyncOperationContextStore,
        },
        {
          provide: IDEMPOTENCY_SERVICE,
          useFactory: () =>
            new IdempotencyService({
              store: new InMemoryIdempotencyStore(),
              crypto: NODE_IDEMPOTENCY_CRYPTO,
              clock: { now: () => Date.now() },
            }),
        },
        IdempotencyInterceptor,
        { provide: APP_INTERCEPTOR, useClass: OperationContextInterceptor },
        { provide: APP_FILTER, useClass: HttpErrorFilter },
      ],
    };
  }
}

/** Aplicação Nest real com guard, contexto e idempotência; autenticação é dublê. */
export async function createIdempotencyFixtureApp(
  state: FixtureState = createFixtureState(),
): Promise<{ app: INestApplication; state: FixtureState }> {
  const moduleRef = await Test.createTestingModule({
    imports: [FixtureModule.register(state)],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return { app, state };
}
