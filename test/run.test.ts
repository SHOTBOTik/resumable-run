import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Checkpoint, mergeCheckpoints } from '../src/checkpoint.ts';
import { forEachLimit } from '../src/pool.ts';
import { run } from '../src/run.ts';

const root = mkdtempSync(join(tmpdir(), 'resumable-run-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const d = join(root, String(n++));
  return d;
};

const crashScript = fileURLToPath(new URL('./fixtures/crash-run.ts', import.meta.url));
const runChild = (dir: string, crashAt: string) => spawnSync(process.execPath, [crashScript, dir, crashAt, '4'], { encoding: 'utf8' });

test('падение посреди прохода: продолжение без потерь и без повторов', () => {
  const dir = fresh();
  const first = runChild(dir, 'https://example.com/page/37');
  assert.equal(first.status, 77, first.stderr);
  const afterCrash = readFileSync(join(dir, 'effects.log'), 'utf8').split('\n').filter(Boolean);
  assert.ok(afterCrash.length > 10 && afterCrash.length < 60, `до падения выполнено ${afterCrash.length}`);
  // что выполнено, то и записано в контрольную точку
  assert.equal(new Checkpoint(join(dir, 'checkpoint.json'), { tag: '1/1' }).size, afterCrash.length);

  const second = runChild(dir, '-');
  assert.equal(second.status, 0, second.stderr);
  const summary = JSON.parse(second.stdout) as { skipped: number; done: number; failed: number; results: number };
  assert.deepEqual(summary, { skipped: afterCrash.length, done: 60 - afterCrash.length, failed: 0, results: 60 });

  const effects = readFileSync(join(dir, 'effects.log'), 'utf8').split('\n').filter(Boolean);
  assert.equal(effects.length, 60, 'каждая задача выполнена ровно один раз');
  assert.equal(new Set(effects).size, 60);
  assert.ok(!existsSync(join(dir, 'checkpoint.json.tmp')));
});

test('упавшие задачи не отмечаются и повторяются следующим запуском', async () => {
  const dir = fresh();
  const urls = Array.from({ length: 20 }, (_, i) => `https://example.com/item/${i}`);
  const calls = new Map<string, number>();
  const task = async (u: string) => {
    calls.set(u, (calls.get(u) ?? 0) + 1);
    if (u.endsWith('/3') && calls.get(u) === 1) throw new Error('503');
    return u.length;
  };
  const a = await run({ items: urls, id: (u) => u, task, checkpoint: join(dir, 'cp.json') });
  assert.equal(a.done, 19);
  assert.equal(a.failed, 1);
  assert.equal(a.errors[0]?.id, 'https://example.com/item/3');
  const b = await run({ items: urls, id: (u) => u, task, checkpoint: join(dir, 'cp.json') });
  assert.deepEqual([b.skipped, b.done, b.failed], [19, 1, 0]);
  assert.equal(b.results.size, 20);
  assert.ok([...calls.values()].every((c, i) => c === (urls[i]!.endsWith('/3') ? 2 : 1)));
});

test('отмена: новые задачи не стартуют, начатые доделываются и записываются', async () => {
  const dir = fresh();
  const ctrl = new AbortController();
  const items = Array.from({ length: 50 }, (_, i) => i);
  const r = await run({
    items,
    id: String,
    concurrency: 3,
    checkpoint: join(dir, 'cp.json'),
    signal: ctrl.signal,
    task: async (i) => {
      if (i === 10) ctrl.abort();
      await new Promise((res) => setTimeout(res, 1));
      return i * 2;
    },
  });
  assert.equal(r.aborted, true);
  assert.ok(r.done >= 11 && r.done <= 13, `сделано ${r.done}`);
  const rest = await run({ items, id: String, checkpoint: join(dir, 'cp.json'), task: async (i) => i * 2 });
  assert.equal(rest.skipped, r.done);
  assert.equal(rest.results.size, 50);
  assert.equal(rest.results.get('49'), 98);
});

test('лимит параллельности соблюдается', async () => {
  let active = 0;
  let peak = 0;
  const started: number[] = [];
  await forEachLimit(Array.from({ length: 30 }, (_, i) => i), 5, async (i) => {
    started.push(i);
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 2));
    active--;
  });
  assert.equal(peak, 5);
  assert.deepEqual(started, Array.from({ length: 30 }, (_, i) => i));
  let peakRun = 0;
  active = 0;
  await run({
    items: Array.from({ length: 20 }, (_, i) => i),
    id: String,
    concurrency: 2,
    checkpoint: join(fresh(), 'cp.json'),
    task: async () => {
      active++;
      peakRun = Math.max(peakRun, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
    },
  });
  assert.equal(peakRun, 2);
});

test('дубли id в списке выполняются один раз', async () => {
  let calls = 0;
  const r = await run({
    items: ['a', 'b', 'a', 'c', 'b'],
    id: (x) => x,
    checkpoint: join(fresh(), 'cp.json'),
    task: async () => ++calls,
  });
  assert.equal(r.total, 3);
  assert.equal(calls, 3);
});

test('задача без результата (undefined) тоже записана и при перезапуске не повторяется', async () => {
  let calls = 0;
  const opts = { items: ['a', 'b', 'c'], id: (x: string) => x, checkpoint: join(fresh(), 'cp.json'), task: async () => { calls++; } };
  const first = await run(opts);
  assert.equal(first.done, 3);
  const second = await run(opts);
  assert.equal(second.skipped, 3);
  assert.equal(second.done, 0);
  assert.equal(calls, 3);
});

test('результат, который не записать в JSON, — понятная ошибка с id задачи, остальные задачи не страдают', async () => {
  const file = join(fresh(), 'cp.json');
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const results: Record<string, unknown> = { a: 1n, b: 2, c: cyclic, d: () => 0, e: 'ok' };
  const opts = { items: Object.keys(results), id: (x: string) => x, checkpoint: file, concurrency: 1, task: async (x: string) => results[x] };
  const first = await run(opts);
  assert.deepEqual([first.done, first.failed], [2, 3]);
  assert.deepEqual(first.errors.map((e) => e.id), ['a', 'c', 'd']);
  assert.match(String(first.errors[0]!.error), /задача a: результат не записать в JSON .*BigInt/);
  assert.match(String(first.errors[2]!.error), /задача d: результат типа function/);
  // в файл попали только хорошие результаты, следующий запуск повторит упавшие
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).done).sort(), ['b', 'e']);
  results.a = '1';
  const second = await run(opts);
  assert.deepEqual([second.skipped, second.done, second.failed], [2, 1, 2]);
});

test('контрольная точка: атомарная запись, обрывок .tmp игнорируется, битый файл — ошибка', () => {
  const dir = fresh();
  const file = join(dir, 'cp.json');
  const cp = new Checkpoint<number>(file, { flushEvery: 2 });
  cp.set('a', 1);
  assert.ok(!existsSync(file), 'flushEvery: 2 — после первой записи файла ещё нет');
  cp.set('b', 2);
  assert.deepEqual(readdirSync(dir), ['cp.json']);
  // процесс убит посреди записи: остался недописанный временный файл
  writeFileSync(`${file}.tmp`, '{"format":"resumable-run/checkp');
  const again = new Checkpoint<number>(file);
  assert.deepEqual([...again.entries()], [['a', 1], ['b', 2]]);
  assert.ok(!existsSync(`${file}.tmp`));
  assert.equal(new Checkpoint(file, { fresh: true }).size, 0);
  writeFileSync(file, '{"format":');
  assert.throws(() => new Checkpoint(file), /не читается/);
});

test('контрольная точка другого шарда не открывается; mergeCheckpoints собирает шарды', async () => {
  const dir = fresh();
  const items = Array.from({ length: 40 }, (_, i) => `https://example.com/doc/${i}`);
  const files = [1, 2, 3].map((i) => join(dir, `cp-${i}of3.json`));
  for (const [i, file] of files.entries()) {
    await run({ items, id: (u) => u, shard: `${i + 1}/3`, checkpoint: file, task: async (u) => u.length });
  }
  await assert.rejects(run({ items, id: (u) => u, shard: '2/3', checkpoint: files[0]!, task: async () => 0 }), /1\/3/);
  assert.equal(mergeCheckpoints<number>(files).size, 40);
});
