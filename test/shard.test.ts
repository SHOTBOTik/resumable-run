import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { run } from '../src/run.ts';
import { inShard, parseShard, shardFromArgv, shardOf } from '../src/shard.ts';

const dir = mkdtempSync(join(tmpdir(), 'resumable-run-shard-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const ids = Array.from({ length: 2000 }, (_, i) => `https://example.com/file/${i}.json`);

test('шарды не пересекаются и вместе покрывают всё, доли примерно равны', () => {
  for (const count of [2, 3, 4, 7]) {
    const buckets = Array.from({ length: count }, (_, k) => ids.filter((id) => inShard(id, { index: k + 1, count })));
    const all = buckets.flat();
    assert.equal(all.length, ids.length, `n=${count}: сумма шардов`);
    assert.equal(new Set(all).size, ids.length, `n=${count}: пересечение`);
    const fair = ids.length / count;
    for (const b of buckets) assert.ok(b.length > fair * 0.8 && b.length < fair * 1.2, `n=${count}: перекос ${buckets.map((x) => x.length)}`);
  }
});

test('распределение стабильно: не зависит от порядка и состава списка', () => {
  const before = new Map(ids.map((id) => [id, shardOf(id, 4)]));
  const shuffled = [...ids].reverse().slice(0, 500);
  for (const id of shuffled) assert.equal(shardOf(id, 4), before.get(id));
  // известные значения: сменится хэш или формула — старые контрольные точки шардов разъедутся, тест это заметит
  assert.deepEqual([0, 1, 2].map((i) => shardOf(`https://example.com/file/${i}.json`, 4)), [1, 2, 4]);
  assert.equal(shardOf('x', 1), 1);
});

test('run по шардам: вместе ровно весь список, каждая задача один раз', async () => {
  const items = ids.slice(0, 300);
  const seen: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const r = await run({
      items,
      id: (u) => u,
      shard: { index: i, count: 3 },
      checkpoint: join(dir, `cp-${i}.json`),
      concurrency: 8,
      task: async (u) => {
        seen.push(u);
      },
    });
    assert.equal(r.total, 300);
    assert.equal(r.done, r.inShard);
  }
  assert.equal(seen.length, 300);
  assert.equal(new Set(seen).size, 300);
});

test('parseShard и shardFromArgv', () => {
  assert.deepEqual(parseShard(undefined), { index: 1, count: 1 });
  assert.deepEqual(parseShard('2/4'), { index: 2, count: 4 });
  assert.throws(() => parseShard('0/4'));
  assert.throws(() => parseShard('5/4'));
  assert.throws(() => parseShard('abc'));
  assert.deepEqual(shardFromArgv(['--shard', '3/5']), { index: 3, count: 5 });
  assert.deepEqual(shardFromArgv(['--x', '--shard=1/2']), { index: 1, count: 2 });
  assert.deepEqual(shardFromArgv([]), { index: 1, count: 1 });
  assert.throws(() => shardFromArgv(['--shard']));
  assert.throws(() => shardFromArgv(['--shard=']));
});
