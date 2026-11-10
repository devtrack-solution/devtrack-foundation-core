import {
  BadRequestException,
  NotFoundException,
  type ArgumentsHost,
} from '@nestjs/common';
import { AuthorizationError } from '../../../application/security/operation-authorizer';
import { AuthenticationError } from '../../../application/security/authentication.service';
import { HttpErrorFilter } from './http-error.filter';
import { CORRELATION_ID_HEADER, type HttpRequestLike } from '../request-state';

interface FakeResponse {
  headersSent: boolean;
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  setHeader(name: string, value: string): void;
  status(code: number): { json(body: unknown): void };
}

function host(headers: Record<string, string> = {}) {
  const request: HttpRequestLike = { headers };
  const response: FakeResponse = {
    headersSent: false,
    statusCode: 0,
    body: undefined,
    headers: {},
    setHeader: (name: string, value: string) => {
      response.headers[name] = value;
    },
    status: (code: number) => {
      response.statusCode = code;
      return {
        json: (body: unknown) => {
          response.body = body;
        },
      };
    },
  };
  const argumentsHost = {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  return { argumentsHost, response };
}

describe('HttpErrorFilter', () => {
  const filter = new HttpErrorFilter();

  it.each([
    [
      'invalid_credentials',
      new AuthenticationError('invalid_credentials'),
      401,
      'unauthorized',
    ],
    [
      'authentication_unavailable',
      new AuthenticationError('authentication_unavailable'),
      503,
      'service_unavailable',
    ],
    [
      'refresh_conflict',
      new AuthenticationError('refresh_conflict'),
      409,
      'refresh_conflict',
    ],
    ['permissão negada', new AuthorizationError(), 403, 'forbidden'],
    [
      'erro genérico',
      new Error('connection string postgres://user:pw@db'),
      500,
      'internal_error',
    ],
  ])('mapeia %s para %i sem vazar detalhes', (_name, error, status, code) => {
    const { argumentsHost, response } = host();
    filter.catch(error, argumentsHost);
    expect(response.statusCode).toBe(status);
    const body = JSON.stringify(response.body);
    expect(response.body).toMatchObject({ statusCode: status, error: code });
    expect(body).not.toMatch(
      /postgres|pw@|stack|Error|invalid_credentials|authentication_unavailable/,
    );
  });

  it('preserva o status de HttpException sem expor a mensagem', () => {
    const { argumentsHost, response } = host();
    filter.catch(new NotFoundException('rota secreta'), argumentsHost);
    expect(response.statusCode).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain('rota secreta');
    filter.catch(new BadRequestException('campo interno'), argumentsHost);
    expect(response.statusCode).toBe(400);
  });

  it('devolve o correlationId recebido no header e no corpo', () => {
    const { argumentsHost, response } = host({ 'x-correlation-id': 'corr-42' });
    filter.catch(new AuthorizationError(), argumentsHost);
    expect(response.headers[CORRELATION_ID_HEADER]).toBe('corr-42');
    expect(response.body).toMatchObject({ correlationId: 'corr-42' });
  });

  it('responde refresh_conflict com 409 e corpo exato, com correlationId', () => {
    const { argumentsHost, response } = host({
      'x-correlation-id': 'corr-409',
    });
    filter.catch(new AuthenticationError('refresh_conflict'), argumentsHost);
    expect(response.statusCode).toBe(409);
    expect(response.headers[CORRELATION_ID_HEADER]).toBe('corr-409');
    expect(response.body).toEqual({
      statusCode: 409,
      error: 'refresh_conflict',
      correlationId: 'corr-409',
    });
  });

  it('gera correlação quando o header é inválido', () => {
    const { argumentsHost, response } = host({ 'x-correlation-id': 'bad id' });
    filter.catch(new Error('x'), argumentsHost);
    const id = response.headers[CORRELATION_ID_HEADER];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.body).toMatchObject({ correlationId: id });
  });
});
