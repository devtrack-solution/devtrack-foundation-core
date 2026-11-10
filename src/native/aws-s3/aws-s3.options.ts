/** Content-Types permitidos por padrão. A allowlist do host só pode restringir ou usar estes valores. */
export const AWS_S3_DEFAULT_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

export const AWS_S3_TIMEOUT_MIN_MS = 100;
export const AWS_S3_TIMEOUT_MAX_MS = 60_000;
export const AWS_S3_MAX_ATTEMPTS_LIMIT = 5;
export const AWS_S3_DEFAULT_TIMEOUT_MS = 5_000;
export const AWS_S3_DEFAULT_MAX_ATTEMPTS = 3;
export const AWS_S3_DEFAULT_MAX_OBJECT_BYTES = 10 * 1024 * 1024;
export const AWS_S3_MAX_OBJECT_BYTES_LIMIT = 100 * 1024 * 1024;

export type AwsS3ServerSideEncryption =
  | { readonly mode: 'AES256' }
  | { readonly mode: 'aws:kms'; readonly kmsKeyId: string };

/**
 * Configuração do host. Credenciais NUNCA entram aqui: o SDK usa a cadeia padrão
 * (variáveis de ambiente, perfil do host, role de execução, IMDS).
 */
export interface AwsS3Options {
  readonly region: string;
  readonly bucket: string;
  /** Endpoint alternativo (ex.: LocalStack). Omitido em AWS real. Somente http ou https, sem credenciais na URL. */
  readonly endpoint?: string;
  /** Obrigatório em LocalStack/MinIO; padrão false (virtual-hosted). */
  readonly forcePathStyle?: boolean;
  /** Prazo por requisição, em ms (100 a 60000). Padrão 5000. */
  readonly timeoutMs?: number;
  /** Tentativas totais, incluindo a primeira (1 a 5). Padrão 3. */
  readonly maxAttempts?: number;
  /** Teto absoluto de leitura e gravação por objeto, em bytes. Padrão 10 MiB. */
  readonly maxObjectBytes?: number;
  /** Subconjunto de AWS_S3_DEFAULT_CONTENT_TYPES aceito em gravações. Padrão: todos. */
  readonly contentTypeAllowlist?: readonly string[];
  /** Criptografia no servidor. Padrão SSE-S3 (AES256). Não há modo sem criptografia. */
  readonly serverSideEncryption?: AwsS3ServerSideEncryption;
}

export interface ResolvedAwsS3Options {
  readonly region: string;
  readonly bucket: string;
  readonly endpoint: string | undefined;
  readonly forcePathStyle: boolean;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly maxObjectBytes: number;
  readonly contentTypeAllowlist: readonly string[];
  readonly serverSideEncryption: AwsS3ServerSideEncryption;
}

/** Erro de configuração. A mensagem cita apenas o campo afetado, nunca valores. */
export class AwsS3ConfigError extends Error {
  constructor(field: string) {
    super(`Invalid AWS S3 configuration: ${field}`);
    this.name = 'AwsS3ConfigError';
  }
}

const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$|^[a-z0-9-]{1,40}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const KMS_KEY_ID = /^[A-Za-z0-9:/_+=.@-]{1,2048}$/;
const MIME = /^[a-z]+\/[a-z0-9.+-]+$/;

function isInteger(value: unknown, min: number, max: number): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= min &&
    (value as number) <= max
  );
}

function resolveEndpoint(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 2048)
    throw new AwsS3ConfigError('endpoint');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AwsS3ConfigError('endpoint');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  )
    throw new AwsS3ConfigError('endpoint');
  return url.origin;
}

function resolveEncryption(value: unknown): AwsS3ServerSideEncryption {
  if (value === undefined) return { mode: 'AES256' };
  if (typeof value !== 'object' || value === null)
    throw new AwsS3ConfigError('serverSideEncryption');
  const candidate = value as { mode?: unknown; kmsKeyId?: unknown };
  if (candidate.mode === 'AES256') return { mode: 'AES256' };
  if (
    candidate.mode === 'aws:kms' &&
    typeof candidate.kmsKeyId === 'string' &&
    KMS_KEY_ID.test(candidate.kmsKeyId)
  )
    return { mode: 'aws:kms', kmsKeyId: candidate.kmsKeyId };
  throw new AwsS3ConfigError('serverSideEncryption');
}

function resolveAllowlist(value: unknown): readonly string[] {
  if (value === undefined) return [...AWS_S3_DEFAULT_CONTENT_TYPES];
  if (!Array.isArray(value) || value.length === 0 || value.length > 8)
    throw new AwsS3ConfigError('contentTypeAllowlist');
  const unique = new Set<string>();
  for (const entry of value) {
    if (
      typeof entry !== 'string' ||
      !(AWS_S3_DEFAULT_CONTENT_TYPES as readonly string[]).includes(entry) ||
      !MIME.test(entry)
    )
      throw new AwsS3ConfigError('contentTypeAllowlist');
    unique.add(entry);
  }
  return [...unique].sort();
}

/**
 * Valida toda a configuração antes de criar o cliente. Falha com AwsS3ConfigError
 * citando somente o campo. Não aceita credenciais nem valores fora dos limites.
 */
export function resolveAwsS3Options(
  options: AwsS3Options,
): ResolvedAwsS3Options {
  if (typeof options !== 'object' || options === null)
    throw new AwsS3ConfigError('options');
  if (typeof options.region !== 'string' || !REGION.test(options.region))
    throw new AwsS3ConfigError('region');
  if (typeof options.bucket !== 'string' || !BUCKET.test(options.bucket))
    throw new AwsS3ConfigError('bucket');
  if (
    options.forcePathStyle !== undefined &&
    typeof options.forcePathStyle !== 'boolean'
  )
    throw new AwsS3ConfigError('forcePathStyle');
  const timeoutMs = options.timeoutMs ?? AWS_S3_DEFAULT_TIMEOUT_MS;
  if (!isInteger(timeoutMs, AWS_S3_TIMEOUT_MIN_MS, AWS_S3_TIMEOUT_MAX_MS))
    throw new AwsS3ConfigError('timeoutMs');
  const maxAttempts = options.maxAttempts ?? AWS_S3_DEFAULT_MAX_ATTEMPTS;
  if (!isInteger(maxAttempts, 1, AWS_S3_MAX_ATTEMPTS_LIMIT))
    throw new AwsS3ConfigError('maxAttempts');
  const maxObjectBytes =
    options.maxObjectBytes ?? AWS_S3_DEFAULT_MAX_OBJECT_BYTES;
  if (!isInteger(maxObjectBytes, 1, AWS_S3_MAX_OBJECT_BYTES_LIMIT))
    throw new AwsS3ConfigError('maxObjectBytes');

  return {
    region: options.region,
    bucket: options.bucket,
    endpoint: resolveEndpoint(options.endpoint),
    forcePathStyle: options.forcePathStyle ?? false,
    timeoutMs,
    maxAttempts,
    maxObjectBytes,
    contentTypeAllowlist: resolveAllowlist(options.contentTypeAllowlist),
    serverSideEncryption: resolveEncryption(options.serverSideEncryption),
  };
}
