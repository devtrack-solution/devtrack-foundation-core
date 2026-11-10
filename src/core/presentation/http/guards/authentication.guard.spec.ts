/* eslint-disable @typescript-eslint/require-await -- dublês de porta assíncronos sem await */
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { OperationContext } from '../../../application/context/operation-context';
import {
  AuthorizationError,
  type OperationAuthorizationRequest,
  type OperationAuthorizer,
} from '../../../application/security/operation-authorizer';
import { AuthenticationError } from '../../../application/security/authentication.service';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { operationContextOf, type HttpRequestLike } from '../request-state';
import {
  AuthenticationGuard,
  extractBearerToken,
} from './authentication.guard';

class Controller {
  @RequirePermissions('things:write')
  protectedHandler(this: void): void {
    return undefined;
  }
}

const CONTEXT: OperationContext = {
  correlationId: 'corr-ok',
  principal: { subjectId: 'user-a', tenantId: 'tenant-a', permissions: [] },
  deadlineAt: 2_000,
};

function executionContext(request: HttpRequestLike): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => Controller.prototype.protectedHandler,
    getClass: () => Controller,
  } as unknown as ExecutionContext;
}

function guardWith(authorize: jest.Mock) {
  const authorizer = { authorize } as unknown as OperationAuthorizer;
  return new AuthenticationGuard(authorizer, new Reflector());
}

describe('extractBearerToken', () => {
  it('extrai o token de um header Bearer bem formado', () => {
    expect(extractBearerToken('Bearer abc.def-ghi')).toBe('abc.def-ghi');
    expect(extractBearerToken('bearer abc')).toBe('abc');
  });

  it.each([
    undefined,
    '',
    'Basic abc',
    'Bearer',
    'Bearer a b',
    ['Bearer abc', 'Bearer def'],
  ])('ignora header inválido: %s', (header) => {
    expect(extractBearerToken(header)).toBeUndefined();
  });
});

describe('AuthenticationGuard', () => {
  it('nega sem chamar o autorizador quando o header Bearer está ausente', async () => {
    const authorize = jest.fn();
    const request: HttpRequestLike = { headers: {} };
    await expect(
      guardWith(authorize).canActivate(executionContext(request)),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(authorize).not.toHaveBeenCalled();
  });

  it('autoriza com permissões do decorator e estabelece o contexto na requisição', async () => {
    const authorize = jest.fn(async () => CONTEXT);
    const request: HttpRequestLike = {
      headers: {
        authorization: 'Bearer opaque',
        'x-correlation-id': 'corr-ok',
      },
    };
    await expect(
      guardWith(authorize).canActivate(executionContext(request)),
    ).resolves.toBe(true);
    expect(authorize).toHaveBeenCalledWith({
      bearerToken: 'opaque',
      correlationId: 'corr-ok',
      requiredPermissions: ['things:write'],
    } satisfies OperationAuthorizationRequest);
    expect(operationContextOf(request)).toBe(CONTEXT);
  });

  it('substitui correlação inválida antes de autorizar', async () => {
    const seen: OperationAuthorizationRequest[] = [];
    const authorize = jest.fn(async (sent: OperationAuthorizationRequest) => {
      seen.push(sent);
      return CONTEXT;
    });
    const request: HttpRequestLike = {
      headers: { authorization: 'Bearer opaque', 'x-correlation-id': 'bad id' },
    };
    await guardWith(authorize).canActivate(executionContext(request));
    expect(seen[0]?.correlationId).not.toBe('bad id');
    expect(seen[0]?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('repassa negações de autenticação e permissão sem alterar o código', async () => {
    const denied = jest.fn(async () => {
      throw new AuthenticationError('invalid_credentials');
    });
    await expect(
      guardWith(denied).canActivate(
        executionContext({ headers: { authorization: 'Bearer x' } }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });

    const forbidden = jest.fn(async () => {
      throw new AuthorizationError();
    });
    await expect(
      guardWith(forbidden).canActivate(
        executionContext({ headers: { authorization: 'Bearer x' } }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('transforma qualquer falha inesperada em authentication_unavailable', async () => {
    const broken = jest.fn(async () => {
      throw new Error('segredo do adapter');
    });
    const request: HttpRequestLike = {
      headers: { authorization: 'Bearer x' },
    };
    const outcome = await guardWith(broken)
      .canActivate(executionContext(request))
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(AuthenticationError);
    expect((outcome as AuthenticationError).code).toBe(
      'authentication_unavailable',
    );
    expect(operationContextOf(request)).toBeUndefined();
  });
});
