/**
 * Обработать items не больше чем по concurrency одновременно. Порядок старта — порядок в списке.
 * Ошибку fn пул не ловит: пусть fn решает сама. После отмены signal новые элементы не берутся,
 * начатые доделываются.
 */
export async function forEachLimit<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !signal?.aborted) {
      const i = next++;
      await fn(items[i]!, i);
    }
  };
  const n = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length));
  await Promise.all(Array.from({ length: n }, worker));
}
