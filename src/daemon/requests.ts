export type Pending<T> = {
  id: string;
  resolve: (value: T) => void;
  createdAt: number;
  timer: NodeJS.Timeout;
};

/**
 * Correlates a host-side question (permission, or the agent asking the user)
 * with the UI response that answers it. Entries time out so a vanished browser
 * tab can never wedge the agent turn.
 */
export class PendingRegistry<T> {
  #entries = new Map<string, Pending<T>>();

  readonly timeoutMs: number;

  constructor(timeoutMs = 5 * 60_000) {
    this.timeoutMs = timeoutMs;
  }

  wait(id: string): Promise<T> {
    const existing = this.#entries.get(id);
    if (existing) return new Promise<T>((resolve) => existing.resolve = resolve);

    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => {
        this.#entries.delete(id);
        resolve(undefined as T);
      }, this.timeoutMs);
      // Deliberately unref'd above so a pending prompt never holds the process
      // open; it still resolves the promise so the agent turn can finish.
      timer.unref?.();
      this.#entries.set(id, { id, resolve, createdAt: Date.now(), timer });
    });
  }

  settle(id: string, value: T): boolean {
    const entry = this.#entries.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.#entries.delete(id);
    entry.resolve(value);
    return true;
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  get size(): number {
    return this.#entries.size;
  }

  clear(): void {
    for (const entry of this.#entries.values()) clearTimeout(entry.timer);
    this.#entries.clear();
  }
}
