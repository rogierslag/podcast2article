/** FIFO slots with abortable waits; each acquired slot must be released in finally. */
export class ConcurrencyGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal.removeEventListener("abort", abort);
        this.active += 1;
        resolve();
      };
      const abort = () => {
        const index = this.waiting.indexOf(start);
        if (index !== -1) {
          this.waiting.splice(index, 1);
        }
        reject(signal.reason);
      };
      if (this.active < this.limit) {
        start();
      } else {
        this.waiting.push(start);
        signal.addEventListener("abort", abort, { once: true });
      }
    });
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      this.active -= 1;
      this.waiting.shift()?.();
    };
    if (signal.aborted) {
      release();
      signal.throwIfAborted();
    }
    return release;
  }
}
