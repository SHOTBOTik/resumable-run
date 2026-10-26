import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export interface CheckpointOptions {
  /** Начать заново: старый файл удаляется. */
  fresh?: boolean;
  /** Сбрасывать на диск после каждых N новых записей. По умолчанию 1 — после каждой. */
  flushEvery?: number;
  /** Метка прохода, например шард «2/4». Файл с другой меткой не откроется: так не смешать два разных прохода. */
  tag?: string;
}

interface FileShape<T> {
  format: 'resumable-run/checkpoint@1';
  tag: string | null;
  savedAt: string;
  done: Record<string, T>;
}

const FORMAT = 'resumable-run/checkpoint@1';

/**
 * Контрольная точка: какие задачи готовы и с каким результатом.
 * Файл всегда пишется целиком во временный файл и подменяется через rename,
 * поэтому на диске лежит либо старая, либо новая версия, но не половина.
 */
export class Checkpoint<T = unknown> {
  readonly file: string;
  readonly tag: string | null;
  private done = new Map<string, T>();
  private flushEvery: number;
  private pending = 0;

  constructor(file: string, opts: CheckpointOptions = {}) {
    this.file = file;
    this.tag = opts.tag ?? null;
    this.flushEvery = Math.max(1, Math.floor(opts.flushEvery ?? 1));
    mkdirSync(dirname(file), { recursive: true });
    // временный файл от прерванной записи: основной файл при этом цел
    rmSync(tmpName(file), { force: true });
    if (opts.fresh) rmSync(file, { force: true });
    if (!existsSync(file)) return;
    const data = readCheckpointFile<T>(file);
    if (data.tag !== this.tag) {
      throw new Error(`контрольная точка ${file} записана для «${data.tag ?? '-'}», а открывается для «${this.tag ?? '-'}»`);
    }
    for (const [id, value] of Object.entries(data.done)) this.done.set(id, value);
  }

  has(id: string): boolean {
    return this.done.has(id);
  }

  get(id: string): T | undefined {
    return this.done.get(id);
  }

  get size(): number {
    return this.done.size;
  }

  entries(): IterableIterator<[string, T]> {
    return this.done.entries();
  }

  /** Отметить задачу готовой. На диск попадёт по правилу flushEvery или при flush(). */
  set(id: string, value: T): void {
    this.done.set(id, value);
    if (++this.pending >= this.flushEvery) this.flush();
  }

  /** Записать всё на диск атомарно. */
  flush(): void {
    // JSON.stringify выбрасывает ключ со значением undefined: задача без результата (async () => {…}) не попала бы
    // в файл и выполнилась бы снова при следующем запуске. Поэтому undefined пишется как null.
    const done = Object.fromEntries([...this.done].map(([id, v]) => [id, v === undefined ? null : v])) as Record<string, T>;
    const body: FileShape<T> = { format: FORMAT, tag: this.tag, savedAt: new Date().toISOString(), done };
    writeAtomic(this.file, JSON.stringify(body));
    this.pending = 0;
  }
}

function tmpName(file: string): string {
  return `${file}.tmp`;
}

function readCheckpointFile<T>(file: string): FileShape<T> {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    // Атомарная запись битого файла не оставляет. Если он всё же битый, молча начать
    // заново — значит повторить всю работу, поэтому лучше остановиться.
    throw new Error(`контрольная точка ${file} не читается: ${err instanceof Error ? err.message : String(err)}`);
  }
  const d = data as Partial<FileShape<T>>;
  if (d?.format !== FORMAT || typeof d.done !== 'object' || d.done === null) throw new Error(`${file}: это не контрольная точка resumable-run`);
  return d as FileShape<T>;
}

/** Временный файл, fsync, rename. На Windows rename иногда отбивает антивирус или индексатор — пробуем ещё раз. */
export function writeAtomic(file: string, text: string): void {
  const tmp = tmpName(file);
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}

/** Склеить результаты нескольких контрольных точек, например всех шардов. Метки не проверяются. */
export function mergeCheckpoints<T>(files: string[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const [id, value] of Object.entries(readCheckpointFile<T>(f).done)) out.set(id, value);
  }
  return out;
}
