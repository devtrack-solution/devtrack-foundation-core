import {
  ensureCorrelationId,
  resolveCorrelationId,
  type HttpRequestLike,
} from './request-state';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('correlation id', () => {
  it.each(['abc-123', 'req.2026_11:09', 'A'.repeat(128)])(
    'preserva valor válido: %s',
    (value) => {
      expect(resolveCorrelationId(value)).toBe(value);
    },
  );

  it.each([
    ['vazio', ''],
    ['espaço interno', 'a b'],
    ['quebra de linha', 'ok\nbad'],
    ['caminho', '../etc/passwd'],
    ['iniciando com separador', '-abc'],
    ['tamanho acima do limite', 'A'.repeat(129)],
    ['header repetido', ['a', 'b']],
    ['ausente', undefined],
  ])('substitui valor inválido (%s) por UUID gerado', (_name, value) => {
    expect(resolveCorrelationId(value)).toMatch(UUID);
  });

  it('mantém o mesmo id durante toda a requisição', () => {
    const request: HttpRequestLike = { headers: {} };
    const first = ensureCorrelationId(request);
    expect(ensureCorrelationId(request)).toBe(first);
  });

  it('usa o header válido recebido na requisição', () => {
    const request: HttpRequestLike = {
      headers: { 'x-correlation-id': 'client-42' },
    };
    expect(ensureCorrelationId(request)).toBe('client-42');
  });
});
