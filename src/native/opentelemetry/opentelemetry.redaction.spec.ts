import {
  redactAttributes,
  redactSpan,
  redactText,
} from './opentelemetry.redaction';

describe('telemetry data redaction', () => {
  it('masks bearer tokens, JWTs, emails and CPF in free text', () => {
    const text =
      'Bearer abc.def-123 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln maria@example.test 123.456.789-09';
    const result = redactText(text);
    expect(result).not.toContain('abc.def-123');
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(result).not.toContain('maria@example.test');
    expect(result).not.toContain('123.456.789-09');
    expect(result).toContain('[redacted]');
  });

  it('masks card numbers that pass the Luhn check and keeps other digits', () => {
    expect(redactText('card 4111 1111 1111 1111')).toBe('card [redacted]');
    expect(redactText('order 1234567890123')).toBe('order 1234567890123');
  });

  it('removes forbidden keys and strips query strings from URL-like values', () => {
    const attributes: Record<string, string | number> = {
      'http.request.header.authorization': 'Bearer xyz',
      'http.request.header.cookie': 'session=abc',
      'auth.token': 'tok',
      'user.email': 'a@b.com',
      'user.cpf': '123.456.789-09',
      'http.target': '/probe?email=a@b.com&token=t',
      'url.full': 'http://h/probe?token=t',
      'http.route': '/probe',
      'activity.name': 'probe.activity',
      'http.status_code': 200,
    };
    redactAttributes(attributes);
    expect(Object.keys(attributes).sort()).toEqual(
      [
        'activity.name',
        'http.route',
        'http.status_code',
        'http.target',
        'url.full',
      ].sort(),
    );
    expect(attributes['http.target']).toBe('/probe');
    expect(attributes['url.full']).toBe('http://h/probe');
    expect(attributes['http.status_code']).toBe(200);
  });

  it('applies the same filtering to span name, events and links', () => {
    const span = {
      name: 'GET /x?token=abc',
      attributes: { 'http.route': '/x', body: 'a' },
      events: [
        {
          name: 'mail a@b.com',
          attributes: { authorization: 'Bearer q', ok: 'yes' },
        },
      ],
      links: [{ attributes: { cookie: 'c=1', kind: 'link' } }],
    };
    redactSpan(span);
    expect(span.name).toBe('GET /x?token=abc');
    expect(span.attributes).toEqual({ 'http.route': '/x' });
    expect(span.events[0]?.name).toBe('mail [redacted]');
    expect(span.events[0]?.attributes).toEqual({ ok: 'yes' });
    expect(span.links[0]?.attributes).toEqual({ kind: 'link' });
  });
});
