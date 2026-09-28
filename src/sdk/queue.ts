export class AsyncQueue<T> implements AsyncIterableIterator<T> {
  #items: T[] = [];
  #waiters: ((r: IteratorResult<T>) => void)[] = [];
  #closed = false;

  push(item: T): void {
    if (this.#closed) throw new Error('queue is closed');
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#items.push(item);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined as T, done: true });
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.#closed) return Promise.resolve({ value: undefined as T, done: true });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}
