import { randomUUID } from 'node:crypto';
import { ObjectStorageError } from '../../../src/core/application/storage';
import type { ObjectStorage } from '../../../src/core/application/storage';

const PNG = 'image/png';
const bytes = (...values: number[]) => Uint8Array.from(values);

/**
 * Suíte de contrato da porta ObjectStorage. Executada, com a mesma definição,
 * contra o duplo em memória (teste unitário) e contra o adapter S3 em LocalStack
 * (test/aws-s3.e2e-spec.ts). Cada teste usa um tenant novo para isolar o bucket
 * compartilhado.
 */
export function describeObjectStorageContract(
  label: string,
  factory: () => ObjectStorage | Promise<ObjectStorage>,
): void {
  describe(`contrato ObjectStorage: ${label}`, () => {
    let storage: ObjectStorage;
    let tenant: string;
    const key = (name = 'avatar') => `tenants/${tenant}/contacts/c1/${name}`;

    beforeEach(async () => {
      storage = await factory();
      tenant = `t-${randomUUID()}`;
    });

    it('grava e lê bytes e Content-Type sem alteração', async () => {
      const body = bytes(0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255);
      await storage.put({ key: key(), body, contentType: PNG, maxBytes: 1024 });
      const stored = await storage.get(key());
      expect(Array.from(stored.body)).toEqual(Array.from(body));
      expect(stored.contentType).toBe(PNG);
    });

    it('sobrescreve a chave existente', async () => {
      await storage.put({
        key: key(),
        body: bytes(1, 2, 3),
        contentType: PNG,
        maxBytes: 10,
      });
      await storage.put({
        key: key(),
        body: bytes(9),
        contentType: PNG,
        maxBytes: 10,
      });
      expect(Array.from((await storage.get(key())).body)).toEqual([9]);
    });

    it('get de chave ausente falha com object_not_found', async () => {
      await expect(storage.get(key('inexistente'))).rejects.toMatchObject({
        code: 'object_not_found',
      });
    });

    it('delete remove o objeto e é idempotente', async () => {
      await storage.put({
        key: key(),
        body: bytes(1),
        contentType: PNG,
        maxBytes: 10,
      });
      await storage.delete(key());
      await expect(storage.get(key())).rejects.toMatchObject({
        code: 'object_not_found',
      });
      await expect(storage.delete(key())).resolves.toBeUndefined();
    });

    it('recusa body acima de maxBytes sem gravar nada', async () => {
      const error = await storage
        .put({
          key: key(),
          body: bytes(1, 2, 3, 4),
          contentType: PNG,
          maxBytes: 3,
        })
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(ObjectStorageError);
      expect(error).toMatchObject({ code: 'object_too_large' });
      await expect(storage.get(key())).rejects.toMatchObject({
        code: 'object_not_found',
      });
    });

    it('aceita body exatamente no limite', async () => {
      await storage.put({
        key: key(),
        body: bytes(1, 2, 3),
        contentType: PNG,
        maxBytes: 3,
      });
      expect(Array.from((await storage.get(key())).body)).toEqual([1, 2, 3]);
    });

    it('recusa Content-Type fora da allowlist', async () => {
      await expect(
        storage.put({
          key: key(),
          body: bytes(1),
          contentType: 'text/html',
          maxBytes: 10,
        }),
      ).rejects.toMatchObject({ code: 'invalid_content_type' });
    });

    it.each([
      ['traversal literal', 'tenants/{t}/../outra/avatar'],
      ['segmento ponto-ponto', 'tenants/{t}/contacts/../avatar'],
      ['segmento ponto', 'tenants/{t}/./avatar'],
      ['sem prefixo de tenant', 'contacts/c1/avatar'],
      ['barra inicial', '/tenants/{t}/avatar'],
      ['barra dupla', 'tenants/{t}//avatar'],
      ['barra final', 'tenants/{t}/avatar/'],
      ['caractere fora do conjunto', 'tenants/{t}/ava tar'],
      ['chave vazia', ''],
    ])(
      'recusa chave inválida (%s) em put, get e delete',
      async (_label, template) => {
        const invalid = template.split('{t}').join(tenant);
        await expect(
          storage.put({
            key: invalid,
            body: bytes(1),
            contentType: PNG,
            maxBytes: 10,
          }),
        ).rejects.toMatchObject({ code: 'invalid_object_key' });
        await expect(storage.get(invalid)).rejects.toMatchObject({
          code: 'invalid_object_key',
        });
        await expect(storage.delete(invalid)).rejects.toMatchObject({
          code: 'invalid_object_key',
        });
      },
    );

    it('recusa chave acima do limite de tamanho', async () => {
      const long = `tenants/${tenant}/${'a'.repeat(1100)}`;
      await expect(storage.get(long)).rejects.toMatchObject({
        code: 'invalid_object_key',
      });
    });

    it('isola tenants: a mesma subchave de outro tenant não é lida', async () => {
      await storage.put({
        key: key(),
        body: bytes(7),
        contentType: PNG,
        maxBytes: 10,
      });
      const otherTenantKey = `tenants/outro-${tenant}/contacts/c1/avatar`;
      await expect(storage.get(otherTenantKey)).rejects.toMatchObject({
        code: 'object_not_found',
      });
    });
  });
}
