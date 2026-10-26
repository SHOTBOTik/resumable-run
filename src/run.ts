import { Checkpoint } from './checkpoint.ts';
import { forEachLimit } from './pool.ts';
import { formatShard, inShard, parseShard, wholeRun, type Shard } from './shard.ts';

export interface RunOptions<I, R> {
  items: readonly I[];
  /** Стабильный id задачи: по нему шард и отметка в контрольной точке. */
  id: (item: I) => string;
  task: (item: I, ctx: { id: string; signal: AbortSignal | undefined }) => Promise<R>;
  /** Путь к файлу контрольной точки. */
  checkpoint: string;
  /** Шард: объект или строка «i/n». По умолчанию весь проход. */
  shard?: Shard | string;
  /** Сколько задач одновременно. По умолчанию 4. */
  concurrency?: number;
  /** Начать заново, забыв прошлый прогресс. */
  fresh?: boolean;
  /** Сбрасывать контрольную точку после каждых N готовых задач. По умолчанию 1. */
  flushEvery?: number;
  /** Отмена: новые задачи не стартуют, начатые доделываются, прогресс записывается. */
  signal?: AbortSignal;
  onProgress?: (p: Progress) => void;
}

export interface Progress {
  id: string;
  ok: boolean;
  error?: unknown;
  done: number;
  failed: number;
  pending: number;
}

export interface RunResult<R> {
  /** Уникальных id в списке. */
  total: number;
  /** Из них в этом шарде. */
  inShard: number;
  /** Были готовы ещё до запуска. */
  skipped: number;
  /** Сделаны в этом запуске. */
  done: number;
  /** Упали в этом запуске; в контрольную точку не попали, следующий запуск их повторит. */
  failed: number;
  errors: { id: string; error: unknown }[];
  aborted: boolean;
  /** Все готовые результаты шарда, включая прошлые запуски. */
  results: Map<string, R>;
}

/** Проход по списку задач с контрольной точкой, шардом и лимитом параллельности. */
export async function run<I, R>(o: RunOptions<I, R>): Promise<RunResult<R>> {
  const shard = typeof o.shard === 'string' ? parseShard(o.shard) : (o.shard ?? wholeRun);
  const cp = new Checkpoint<R>(o.checkpoint, {
    tag: formatShard(shard),
    ...(o.fresh ? { fresh: true } : {}),
    ...(o.flushEvery ? { flushEvery: o.flushEvery } : {}),
  });

  const unique = new Map<string, I>();
  for (const item of o.items) {
    const id = o.id(item);
    if (!unique.has(id)) unique.set(id, item);
  }
  const mine = [...unique].filter(([id]) => inShard(id, shard));
  const pending = mine.filter(([id]) => !cp.has(id));
  const res: RunResult<R> = {
    total: unique.size,
    inShard: mine.length,
    skipped: mine.length - pending.length,
    done: 0,
    failed: 0,
    errors: [],
    aborted: false,
    results: new Map(),
  };

  try {
    await forEachLimit(
      pending,
      o.concurrency ?? 4,
      async ([id, item]) => {
        let ok = true;
        let error: unknown;
        try {
          cp.set(id, await o.task(item, { id, signal: o.signal }));
          res.done++;
        } catch (err) {
          ok = false;
          error = err;
          res.failed++;
          res.errors.push({ id, error: err });
        }
        o.onProgress?.({ id, ok, error, done: res.done, failed: res.failed, pending: pending.length - res.done - res.failed });
      },
      o.signal,
    );
  } finally {
    cp.flush();
  }
  res.aborted = o.signal?.aborted ?? false;
  res.results = new Map(cp.entries());
  return res;
}
