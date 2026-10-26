# resumable-run

*In English.* resumable-run walks a large list of tasks so that a crash, a kill or a reboot costs nothing. Finished results go to a checkpoint file that is always written atomically (temp file, fsync, rename), and the next run skips everything already done. `--shard i/n` splits the list between machines or processes by a stable hash of the task id, so shards never overlap and together cover the whole list. A concurrency limit and a cursor-pagination helper with de-duplication and early stop are included. TypeScript, Node ≥ 22.18, zero runtime dependencies.

---

Долгий проход по большому списку задач, который переживает падение.

## Что делает и зачем

Выгрузка десятков тысяч страниц идёт часами. Процесс за это время падает: кончилась память, перезагрузилась машина, его убили по Ctrl+C. Начинать с нуля дорого. resumable-run:

- записывает готовые результаты в **контрольную точку** — атомарно, через временный файл и `rename`;
- при перезапуске **продолжает** с последней точки: готовое пропускает, упавшее повторяет;
- **шардирует** список `--shard i/n` по хэшу id: шарды не пересекаются, вместе покрывают всё, и распределение не зависит от порядка списка;
- держит **лимит параллельности**;
- даёт помощник для **курсорной пагинации** с дедупликацией и ранней остановкой.

Вынесено из моего инструмента для выгрузки больших объёмов публичных данных.

## Быстрый старт

Нужен Node ≥ 22.18: он запускает TypeScript сам, без сборки. Зависимостей во время работы нет.

```sh
git clone https://github.com/SHOTBOTik/resumable-run
```

```ts
// fetch-all.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { formatShard, run, shardFromArgv } from './resumable-run/src/index.ts';

const urls = readFileSync('urls.txt', 'utf8').split('\n').filter(Boolean);
const shard = shardFromArgv(); // --shard 2/4, без флага — весь список

const res = await run({
  items: urls,
  id: (url) => url,
  shard,
  checkpoint: `out/checkpoint-${shard.index}of${shard.count}.json`,
  concurrency: 8,
  task: async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} -> ${r.status}`);
    return { status: r.status, bytes: (await r.text()).length };
  },
  onProgress: (p) => { if (!p.ok) console.warn(p.id, p.error); },
});

console.log(`шард ${formatShard(shard)}: готово ${res.done}, уже было ${res.skipped}, упало ${res.failed}`);
writeFileSync(`out/result-${shard.index}of${shard.count}.json`, JSON.stringify(Object.fromEntries(res.results)));
```

```sh
node fetch-all.ts --shard 1/2     # на одной машине
node fetch-all.ts --shard 2/2     # на другой
# упал? та же команда продолжит с места падения
```

Пакет не публикуется в npm (`"private": true`). Подключайте `src/index.ts` из клона или копируйте нужные файлы в свой проект.

## API

### `run(options)`

| Опция | Что делает |
|---|---|
| `items` | Список задач. Дубли id выполняются один раз. |
| `id(item)` | Стабильный id задачи. По нему шард и отметка в контрольной точке. |
| `task(item, { id, signal })` | Работа. Вернула значение — задача готова и записана; `undefined` записывается как `null`. Бросила — считается упавшей, не записывается и повторится при следующем запуске. |
| `checkpoint` | Путь к файлу контрольной точки. Каталог создаётся сам. |
| `shard` | `{ index, count }` или строка `'2/4'`. По умолчанию весь список. |
| `concurrency` | Сколько задач одновременно, по умолчанию 4. |
| `fresh` | Забыть прошлый прогресс и начать заново. |
| `flushEvery` | Сбрасывать контрольную точку после каждых N готовых задач, по умолчанию 1. |
| `signal` | Отмена: новые задачи не стартуют, начатые доделываются, прогресс записывается. |
| `onProgress(p)` | После каждой задачи: `{ id, ok, error?, done, failed, pending }`. |

Возвращает `{ total, inShard, skipped, done, failed, errors, aborted, results }`. `results` — `Map` id → результат со всеми готовыми задачами шарда, включая прошлые запуски.

### Остальное

- `parseShard('2/4')`, `shardFromArgv(argv?)` (`--shard 2/4` или `--shard=2/4`), `formatShard(shard)`.
- `shardOf(id, count)` — номер шарда для id, с 1; `inShard(id, shard)`.
- `forEachLimit(items, concurrency, fn, signal?)` — пул без контрольной точки.
- `Checkpoint<T>` — сама контрольная точка: `has`, `get`, `set`, `flush`, `entries`, `size`. Опции `fresh`, `flushEvery`, `tag`.
- `mergeCheckpoints(files)` — склеить результаты нескольких шардов в одну `Map`.
- `writeAtomic(file, text)` — запись через временный файл, `fsync` и `rename`.
- `paginate(options)` — курсорная пагинация, см. ниже.

### `paginate({ fetchPage, key, next, stop?, maxPages })`

```ts
import { paginate } from './resumable-run/src/index.ts';

interface Item { id: string; updatedAt: number }

const since = Date.now() - 7 * 24 * 3600_000;
const { items, pages, truncated } = await paginate<Item, string>({
  fetchPage: async (cursor) => {
    const url = new URL('https://api.example.com/v1/items');
    if (cursor) url.searchParams.set('before', cursor);
    return (await (await fetch(url)).json()) as Item[];
  },
  key: (x) => x.id,
  next: (page) => page.at(-1)?.id,              // undefined — страниц больше нет
  stop: (page) => page.some((x) => x.updatedAt < since), // дальше только старое
  maxPages: 500,
});
```

- Элемент с уже виденным `key` отбрасывается: курсор включительный, и на стыке страниц элементы повторяются.
- Конец — пустая страница, страница без новых элементов, `next` вернул `undefined` или сработал `stop`. Страница без новых элементов защищает от вечного цикла, когда сервер отдаёт одно и то же.
- `maxPages` — предохранитель. Если он сработал, `truncated: true`: данные, возможно, ещё были.

## Как устроено

- **Контрольная точка** — один JSON-файл: формат, метка шарда, время и `done` (id → результат). Каждая запись пишет файл целиком во `<файл>.tmp`, делает `fsync` и `rename` поверх старого. Поэтому на диске всегда целая версия: старая или новая. Оставшийся от прерванной записи `.tmp` при запуске удаляется. Битый основной файл — ошибка, а не тихий старт с нуля: тихий старт повторил бы всю работу.
- **Метка шарда.** Файл помнит, для какого шарда он записан. Открыть его с другим `--shard` не выйдет: два разных прохода не смешаются.
- **Шард** — `sha1(id) mod n`. Зависит только от id и `n`, поэтому распределение одинаково между запусками и машинами, даже если список пришёл в другом порядке или вырос.
- **Параллельность** — N воркеров берут задачи из общего списка по порядку.
- **На Windows** `rename` иногда отбивает антивирус или индексатор (`EPERM`, `EBUSY`); запись пробует ещё несколько раз с короткой паузой.

## Ограничения

- Гарантия — «каждая готовая задача записана». Задача, которая была в работе в момент падения, выполнится ещё раз. Если у неё есть побочный эффект снаружи (запись в базу, отправка), делайте его идемпотентным.
- Файл переписывается целиком на каждую запись. Для сотен тысяч задач с крупными результатами поднимите `flushEvery` — ценой того, что после падения повторится до `flushEvery − 1` готовых задач. Или храните в результате только ссылку на файл с данными.
- Все результаты шарда держатся в памяти.
- Шарды при смене `n` перераспределяются: контрольные точки от `--shard i/4` не подходят для `--shard i/8`.
- Один процесс на один файл контрольной точки. Блокировки файла нет.

## Тесты

```sh
npm install      # только typescript и @types/node для проверки типов
npm run typecheck
npm test
```

Тесты на `node:test`, без сети. Падение проверяется настоящим процессом: дочерний процесс проходит по списку URL и умирает посреди прохода, второй запуск продолжает. Тест сверяет журнал побочных эффектов: каждая задача выполнена ровно один раз, контрольная точка совпадает с журналом. Ещё проверяются повтор упавших задач, отмена, лимит параллельности, обрывок `.tmp`, шарды (не пересекаются, покрывают всё, стабильны) и пагинация (без дублей, ранняя остановка, `maxPages`).

## Автор и лицензия

[SHOTBOTik](https://shotbotik.me) · MIT, см. [LICENSE](LICENSE).
