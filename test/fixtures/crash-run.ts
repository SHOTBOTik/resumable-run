// Отдельный процесс для теста падения: проход по списку URL, на задаче crashAt процесс умирает
// на полпути, как от kill или сбоя питания. Аргументы: каталог, crashAt (или «-»), concurrency.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../src/run.ts';

const [dir = '.', crashAt = '-', concurrency = '4'] = process.argv.slice(2);
const urls = Array.from({ length: 60 }, (_, i) => `https://example.com/page/${i}`);

const res = await run({
  items: urls,
  id: (u) => u,
  checkpoint: join(dir, 'checkpoint.json'),
  concurrency: Number(concurrency),
  task: async (url) => {
    await new Promise((r) => setTimeout(r, 1 + (url.length % 3)));
    if (url === crashAt) process.exit(77);
    // журнал побочных эффектов: по нему тест видит, какая задача выполнена сколько раз
    appendFileSync(join(dir, 'effects.log'), url + '\n');
    return { url, size: url.length };
  },
});
process.stdout.write(JSON.stringify({ skipped: res.skipped, done: res.done, failed: res.failed, results: res.results.size }));
