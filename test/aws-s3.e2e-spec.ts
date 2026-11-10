import {
  CreateBucketCommand,
  GetObjectAclCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { StartedTestContainer } from 'testcontainers';
import { S3ObjectStorage } from '../src/native/aws-s3/aws-s3.adapter';
import { resolveAwsS3Options } from '../src/native/aws-s3/aws-s3.options';
import {
  localStackEndpoint,
  LOCALSTACK_REGION,
  startLocalStack,
} from './fixtures/aws-s3-localstack';
import { describeObjectStorageContract } from './fixtures/aws-s3-object-storage/object-storage.contract';

jest.setTimeout(300_000);

const BUCKET = 'foundation-aws-s3-e2e';
const ALL_USERS = 'http://acs.amazonaws.com/groups/global/AllUsers';

let container: StartedTestContainer;
let endpoint: string;
let raw: S3Client;
const savedEnv: Record<string, string | undefined> = {};

function adapter(): S3ObjectStorage {
  return new S3ObjectStorage(
    resolveAwsS3Options({
      region: LOCALSTACK_REGION,
      bucket: BUCKET,
      endpoint,
      forcePathStyle: true,
    }),
  );
}

describe('S3ObjectStorage contra LocalStack (integração AWS separada)', () => {
  beforeAll(async () => {
    // Credenciais de teste do LocalStack, somente no processo de teste. O adapter não as recebe.
    for (const name of [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_REGION',
    ]) {
      savedEnv[name] = process.env[name];
    }
    process.env.AWS_ACCESS_KEY_ID = 'test';
    process.env.AWS_SECRET_ACCESS_KEY = 'test';
    process.env.AWS_REGION = LOCALSTACK_REGION;

    container = await startLocalStack();
    endpoint = localStackEndpoint(container);
    raw = new S3Client({
      region: LOCALSTACK_REGION,
      endpoint,
      forcePathStyle: true,
    });
    await raw.send(new CreateBucketCommand({ Bucket: BUCKET }));
  });

  afterAll(async () => {
    raw?.destroy();
    await container?.stop();
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  describeObjectStorageContract('S3 (LocalStack)', () => adapter());

  it('grava com criptografia no servidor (SSE) visível no HeadObject', async () => {
    const storage = adapter();
    const key = 'tenants/sse-check/contacts/c1/avatar';
    await storage.put({
      key,
      body: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
      contentType: 'image/png',
      maxBytes: 16,
    });
    const head = await raw.send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: key }),
    );
    expect(head.ServerSideEncryption).toBe('AES256');
    expect(head.ContentType).toBe('image/png');
  });

  // LocalStack atende leitura anônima sem aplicar ACL; a evidência de não publicidade é a ACL.
  it('objeto gravado não é público: sem concessão para AllUsers na ACL', async () => {
    const storage = adapter();
    const key = 'tenants/acl-check/contacts/c1/avatar';
    await storage.put({
      key,
      body: Uint8Array.from([1, 2, 3]),
      contentType: 'image/jpeg',
      maxBytes: 16,
    });
    const acl = await raw.send(
      new GetObjectAclCommand({ Bucket: BUCKET, Key: key }),
    );
    const publicGrants = (acl.Grants ?? []).filter(
      (grant) => grant.Grantee?.URI === ALL_USERS,
    );
    expect(publicGrants).toEqual([]);
  });

  it('put envia SSE-S3 mesmo quando o host não configura criptografia', async () => {
    const sent: unknown[] = [];
    const transport = {
      send: (command: unknown) => {
        sent.push(command);
        return Promise.resolve({});
      },
    };
    await new S3ObjectStorage(
      resolveAwsS3Options({ region: LOCALSTACK_REGION, bucket: BUCKET }),
      transport,
    ).put({
      key: 'tenants/sse-enforced/contacts/c1/avatar',
      body: Uint8Array.from([1]),
      contentType: 'image/png',
      maxBytes: 8,
    });
    expect(sent[0]).toBeInstanceOf(PutObjectCommand);
    expect((sent[0] as PutObjectCommand).input.ServerSideEncryption).toBe(
      'AES256',
    );
  });
});
