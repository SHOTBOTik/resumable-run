export interface PaginateOptions<T, C> {
  /** Загрузить страницу; cursor === undefined — первая страница. */
  fetchPage: (cursor: C | undefined) => Promise<T[]>;
  /** Ключ элемента для дедупликации. */
  key: (item: T) => string;
  /** Курсор следующей страницы; undefined — страниц больше нет. */
  next: (page: T[], cursor: C | undefined) => C | undefined;
  /** Ранняя остановка: например, страница уже старше нужного окна. Элементы этой страницы в результат входят. */
  stop?: (page: T[]) => boolean;
  /** Предохранитель от бесконечного источника. */
  maxPages: number;
}

export interface PageResult<T> {
  items: T[];
  pages: number;
  /** Остановились по maxPages, а данные, возможно, ещё были. */
  truncated: boolean;
}

/**
 * Курсорная пагинация с дедупликацией. Страницы могут перекрываться
 * (курсор включительный, записи с одинаковым временем), поэтому страницу без новых
 * элементов считаем концом — иначе вечный цикл на одном и том же курсоре.
 */
export async function paginate<T, C>(o: PaginateOptions<T, C>): Promise<PageResult<T>> {
  const seen = new Set<string>();
  const items: T[] = [];
  let cursor: C | undefined;
  for (let pages = 1; ; pages++) {
    const page = await o.fetchPage(cursor);
    let fresh = 0;
    for (const item of page) {
      const k = o.key(item);
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(item);
      fresh++;
    }
    if (page.length === 0 || fresh === 0 || o.stop?.(page)) return { items, pages, truncated: false };
    const nextCursor = o.next(page, cursor);
    if (nextCursor === undefined) return { items, pages, truncated: false };
    if (pages >= o.maxPages) return { items, pages, truncated: true };
    cursor = nextCursor;
  }
}
