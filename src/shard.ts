import { createHash } from 'node:crypto';

export interface Shard {
  /** Номер шарда, с 1. */
  index: number;
  count: number;
}

export const wholeRun: Shard = { index: 1, count: 1 };

/** «2/4» — второй из четырёх. Пусто — весь проход. */
export function parseShard(value: string | undefined): Shard {
  if (!value) return wholeRun;
  const m = /^(\d+)\/(\d+)$/.exec(value.trim());
  const index = Number(m?.[1]);
  const count = Number(m?.[2]);
  if (!m || count < 1 || index < 1 || index > count) throw new Error(`шард ждёт i/n, 1 ≤ i ≤ n, получено: ${value}`);
  return { index, count };
}

/** Значение --shard из argv: «--shard 2/4» или «--shard=2/4». */
export function shardFromArgv(argv: readonly string[] = process.argv.slice(2)): Shard {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--shard') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error('--shard ждёт значение i/n');
      return parseShard(v);
    }
    if (a.startsWith('--shard=')) {
      const v = a.slice('--shard='.length);
      if (!v) throw new Error('--shard ждёт значение i/n');
      return parseShard(v);
    }
  }
  return wholeRun;
}

export function formatShard(shard: Shard): string {
  return `${shard.index}/${shard.count}`;
}

/** Номер шарда (с 1) для id. Зависит только от id и числа шардов: порядок и состав списка не важны. */
export function shardOf(id: string, count: number): number {
  if (count <= 1) return 1;
  const h = createHash('sha1').update(id).digest().readUInt32BE(0);
  return (h % count) + 1;
}

export function inShard(id: string, shard: Shard): boolean {
  return shardOf(id, shard.count) === shard.index;
}
