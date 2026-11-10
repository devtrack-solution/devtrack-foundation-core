import { BadRequestException } from '@nestjs/common';
import { RequestBodyLimitPipe } from './request-body-limit.pipe';

const pipe = new RequestBodyLimitPipe({ maxDepth: 3, maxBytes: 64 });

describe('RequestBodyLimitPipe', () => {
  it('aceita corpo dentro dos limites e devolve o mesmo valor', () => {
    const body = { a: { b: [1, 2] } };
    expect(pipe.transform(body)).toBe(body);
    expect(pipe.transform(undefined)).toBeUndefined();
  });

  it('rejeita corpo acima do limite de bytes', () => {
    expect(() => pipe.transform({ text: 'x'.repeat(100) })).toThrow(
      BadRequestException,
    );
  });

  it('rejeita corpo acima do limite de profundidade', () => {
    expect(() => pipe.transform({ a: { b: { c: { d: 1 } } } })).toThrow(
      BadRequestException,
    );
    expect(() => pipe.transform([[[[1]]]])).toThrow(BadRequestException);
  });

  it('rejeita corpo não serializável como 400', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => pipe.transform(circular)).toThrow(BadRequestException);
  });

  it.each([
    { maxDepth: 0, maxBytes: 10 },
    { maxDepth: 1.5, maxBytes: 10 },
    { maxDepth: 2, maxBytes: -1 },
  ])('valida limites na construção: %o', (limits) => {
    expect(() => new RequestBodyLimitPipe(limits)).toThrow(
      'Invalid request body limits',
    );
  });
});
