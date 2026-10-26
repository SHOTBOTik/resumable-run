import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paginate } from '../src/paginate.ts';

interface Row { id: string; t: number }
const rows = (ids: number[]): Row[] => ids.map((i) => ({ id: String(i), t: i }));

test('пересекающиеся страницы склеиваются без дублей', async () => {
  const pages: Record<string, Row[]> = { start: rows([1, 2, 3]), '3': rows([3, 4, 5]), '5': rows([5, 6]), '6': rows([6]) };
  const calls: string[] = [];
  const r = await paginate<Row, string>({
    fetchPage: async (c) => { calls.push(c ?? 'start'); return pages[c ?? 'start'] ?? []; },
    key: (x) => x.id,
    next: (page) => page[page.length - 1]!.id, // курсор включительный: страница начинается с него самого
    maxPages: 10,
  });
  assert.deepEqual(r.items.map((x) => x.t), [1, 2, 3, 4, 5, 6]);
  // страница без новых элементов — конец, даже если курсор есть
  assert.deepEqual(calls, ['start', '3', '5', '6']);
  assert.equal(r.truncated, false);
});

test('сервер повторяет одну и ту же страницу — остановка, а не вечный цикл', async () => {
  let calls = 0;
  const r = await paginate<Row, number>({
    fetchPage: async () => { calls++; return rows([1, 2]); },
    key: (x) => x.id,
    next: () => 1,
    maxPages: 1000,
  });
  assert.equal(calls, 2);
  assert.equal(r.items.length, 2);
});

test('ранняя остановка по stop и по отсутствию следующего курсора', async () => {
  let calls = 0;
  const r = await paginate<Row, number>({
    fetchPage: async (c = 100) => { calls++; return rows([c, c - 1]); },
    key: (x) => x.id,
    next: (page) => page[1]!.t - 1,
    stop: (page) => page.some((x) => x.t <= 95),
    maxPages: 100,
  });
  assert.equal(calls, 3);
  assert.deepEqual(r.items.map((x) => x.t), [100, 99, 98, 97, 96, 95]);
  const one = await paginate<Row, number>({ fetchPage: async () => rows([1]), key: (x) => x.id, next: () => undefined, maxPages: 5 });
  assert.equal(one.pages, 1);
  const empty = await paginate<Row, number>({ fetchPage: async () => [], key: (x) => x.id, next: () => 1, maxPages: 5 });
  assert.deepEqual([empty.items.length, empty.pages], [0, 1]);
});

test('maxPages обрезает бесконечный источник и помечает truncated', async () => {
  const r = await paginate<Row, number>({
    fetchPage: async (c = 0) => rows([c * 2, c * 2 + 1]),
    key: (x) => x.id,
    next: (_p, c = 0) => c + 1,
    maxPages: 3,
  });
  assert.equal(r.pages, 3);
  assert.equal(r.items.length, 6);
  assert.equal(r.truncated, true);
});

test('курсор-строка с перекрытием на стыке: 250 записей по 100, без дублей', async () => {
  // id длиннее 2^53: курсор строкой, сравнение через BigInt, иначе числа бы склеились
  const all = Array.from({ length: 250 }, (_, i) => ({ id: String(9_007_199_254_740_993n + BigInt(i) * 2n) })).reverse();
  const cursors: (string | undefined)[] = [];
  const r = await paginate<{ id: string }, string>({
    fetchPage: async (before) => {
      cursors.push(before);
      // сервер «с перекрытием»: отдаёт и запись с самим курсором
      return all.filter((x) => before === undefined || BigInt(x.id) <= BigInt(before)).slice(0, 100);
    },
    key: (x) => x.id,
    next: (page) => (page.length < 100 ? undefined : page[page.length - 1]!.id),
    maxPages: 10,
  });
  assert.equal(r.items.length, 250);
  assert.equal(new Set(r.items.map((x) => x.id)).size, 250);
  assert.equal(cursors[1], all[99]!.id);
  assert.equal(r.truncated, false);
});
