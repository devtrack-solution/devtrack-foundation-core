import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class OwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnershipError';
  }
}

/** Diretório temporário criado por esta execução. Remoção recusa qualquer caminho fora dele. */
export class OwnedTemp {
  readonly root: string;
  private readonly created = new Set<string>();

  constructor(prefix = 'foundation-conformance-') {
    this.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    this.created.add(this.root);
  }

  resolve(relative: string): string {
    const target = path.resolve(this.root, relative);
    const rel = path.relative(this.root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new OwnershipError(`Caminho fora da área temporária: ${relative}`);
    }
    return target;
  }

  track(target: string): void {
    const realTarget = fs.existsSync(target) ? fs.realpathSync(target) : path.resolve(target);
    const rel = path.relative(this.root, realTarget);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new OwnershipError('Não é permitido rastrear arquivo externo');
    }
    this.created.add(realTarget);
  }

  removeAll(): void {
    for (const target of [...this.created].sort((a, b) => b.length - a.length)) {
      const rel = path.relative(this.root, target);
      if (target !== this.root && (rel.startsWith('..') || path.isAbsolute(rel))) {
        throw new OwnershipError('Limpeza recusou caminho externo');
      }
    }
    fs.rmSync(this.root, { recursive: true, force: true });
    this.created.clear();
  }
}

export interface BoundedRun {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly signal: NodeJS.Signals | null;
}

export function runBounded(options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}): Promise<BoundedRun> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, timedOut, truncated, signal });
    };
    const killGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const take = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > options.maxOutputBytes && !truncated) {
        truncated = true;
        killGroup();
      }
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.on('exit', (code, signal) => finish(code, signal));
    child.on('error', () => finish(null, null));
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs);
    options.signal?.addEventListener('abort', () => {
      timedOut = true;
      killGroup();
    }, { once: true });
  });
}

export function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: os.tmpdir(),
    ...extra,
  };
}
