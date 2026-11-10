import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { generateInstrumentationFile } from '../../src/core/infrastructure/composition/composition-generator';

export const ROOT = path.resolve(__dirname, '..', '..');
export const TS_NODE = path.join(
  ROOT,
  'node_modules/ts-node/register/transpile-only',
);
export const PROBE_APP = path.join(__dirname, 'otel-probe-app.ts');
export const LOAD_APP = path.join(__dirname, 'otel-load-app.ts');

export const PROFILE_WITH_OTEL = `foundationApiMajor: 1
natives:
  - id: native/opentelemetry
extensions: []
`;
export const PROFILE_WITHOUT_OTEL = `foundationApiMajor: 1
natives: []
extensions: []
`;

export interface OtlpAttribute {
  readonly key: string;
  readonly value: Record<string, unknown>;
}

export interface OtlpSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: number;
  readonly attributes?: OtlpAttribute[];
}

export interface OtlpMetric {
  readonly name: string;
  readonly unit?: string;
  readonly sum?: { readonly dataPoints: readonly OtlpPoint[] };
  readonly gauge?: { readonly dataPoints: readonly OtlpPoint[] };
  readonly histogram?: { readonly dataPoints: readonly OtlpPoint[] };
}

export interface OtlpPoint {
  readonly attributes?: OtlpAttribute[];
  readonly asInt?: string;
  readonly asDouble?: number;
  readonly count?: string;
}

export interface OtlpPayload {
  readonly resourceSpans?: {
    readonly resource: { readonly attributes: OtlpAttribute[] };
    readonly scopeSpans: { readonly spans: OtlpSpan[] }[];
  }[];
  readonly resourceMetrics?: {
    readonly resource: { readonly attributes: OtlpAttribute[] };
    readonly scopeMetrics: { readonly metrics: OtlpMetric[] }[];
  }[];
}

export interface Received {
  readonly path: string;
  readonly contentType: string;
  readonly body: OtlpPayload;
}

export interface Collector {
  readonly url: string;
  readonly received: Received[];
  close(): Promise<void>;
}

/** Collector de teste: recebe OTLP/HTTP em processo, sem Docker, em porta efêmera. */
export function startCollector(): Promise<Collector> {
  const received: Received[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        path: request.url ?? '',
        contentType: request.headers['content-type'] ?? '',
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as OtlpPayload,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  return listen(server).then((url) => ({
    url,
    received,
    close: () => closeServer(server),
  }));
}

/**
 * Destino que aceita a conexão e nunca responde. Conta requisições recebidas,
 * para o teste saber que a exportação começou antes de enviar SIGTERM.
 */
export function startBlackhole(): Promise<{
  readonly url: string;
  requests(): number;
  close(): Promise<void>;
}> {
  let count = 0;
  const server = http.createServer(() => {
    count += 1;
  });
  return listen(server).then((url) => ({
    url,
    requests: () => count,
    close: () => {
      server.closeAllConnections();
      return closeServer(server);
    },
  }));
}

/** Porta fechada: endereço que recusa conexão, obtido de um servidor já encerrado. */
export async function closedPortUrl(): Promise<string> {
  const server = http.createServer();
  const url = await listen(server);
  await closeServer(server);
  return url;
}

function listen(server: http.Server | net.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function closeServer(server: http.Server | net.Server): Promise<void> {
  return new Promise<void>((done) => server.close(() => done()));
}

export function attribute(
  attributes: readonly OtlpAttribute[] | undefined,
  key: string,
): unknown {
  const found = attributes?.find((item) => item.key === key);
  if (found === undefined) return undefined;
  const value = found.value;
  return (
    value.stringValue ?? value.intValue ?? value.boolValue ?? value.doubleValue
  );
}

export function allSpans(received: Received[]): OtlpSpan[] {
  return received.flatMap((item) =>
    (item.body.resourceSpans ?? []).flatMap((rs) =>
      rs.scopeSpans.flatMap((scope) => scope.spans),
    ),
  );
}

export function allMetrics(received: Received[]): OtlpMetric[] {
  return received.flatMap((item) =>
    (item.body.resourceMetrics ?? []).flatMap((rm) =>
      rm.scopeMetrics.flatMap((scope) => scope.metrics),
    ),
  );
}

/** Gera em diretório temporário os dois arquivos de instrumentation usados pelos testes. */
export function prepareInstrumentationFiles(): {
  readonly tempDir: string;
  readonly on: string;
  readonly off: string;
} {
  const tempDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'foundation-otel-')),
  );
  const on = path.join(tempDir, 'on', 'instrumentation.generated.ts');
  const off = path.join(tempDir, 'off', 'instrumentation.generated.ts');
  fs.mkdirSync(path.dirname(on));
  fs.mkdirSync(path.dirname(off));
  generateInstrumentationFile({
    profileSource: PROFILE_WITH_OTEL,
    extensions: [],
    outputPath: on,
    check: false,
  });
  generateInstrumentationFile({
    profileSource: PROFILE_WITHOUT_OTEL,
    extensions: [],
    outputPath: off,
    check: false,
  });
  return { tempDir, on, off };
}

export interface ChildProcessHandle {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  output(): string;
}

/** Processo filho que imprime `READY <porta>` quando pronto; falha se sair antes. */
export function startProbe(
  script: string,
  env: NodeJS.ProcessEnv,
): Promise<ChildProcessHandle & { readonly port: number }> {
  const handle = spawnChild(['-r', TS_NODE, script], env);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`probe did not start: ${handle.output()}`)),
      60_000,
    );
    handle.child.stdout?.on('data', () => {
      const match = /READY (\d+)/.exec(handle.output());
      if (match !== null) {
        clearTimeout(timer);
        resolve({ ...handle, port: Number(match[1]) });
      }
    });
    void handle.exited.then(() => {
      clearTimeout(timer);
      reject(new Error(`probe exited early: ${handle.output()}`));
    });
  });
}

export function spawnChild(
  args: string[],
  env: NodeJS.ProcessEnv,
): ChildProcessHandle {
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on(
    'data',
    (chunk: Buffer) => (stdout += chunk.toString('utf8')),
  );
  child.stderr?.on(
    'data',
    (chunk: Buffer) => (stderr += chunk.toString('utf8')),
  );
  const exited = new Promise<number | null>((resolve) =>
    child.on('exit', (code) => resolve(code)),
  );
  return { child, exited, output: () => stdout + stderr };
}

export async function post(
  port: number,
  route: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers:
      body === undefined
        ? headers
        : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}
