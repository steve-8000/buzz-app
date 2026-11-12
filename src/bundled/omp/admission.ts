// How many turns run at once: a ceiling for the whole app, and one for each
// repository, so a busy repository cannot starve the others. Turns over a
// ceiling wait in order and start as room opens.
export type Release = () => void;

type Waiter = {
  repo: string;
  perRepo: number;
  resolve(release: Release): void;
  reject(error: Error): void;
  signal: AbortSignal | undefined;
  onAbort(): void;
};

export class Admission {
  private running = 0;
  private readonly byRepo = new Map<string, number>();
  private queue: Waiter[] = [];

  constructor(private readonly total: number) {}

  /** Resolves with the release once the turn may start; rejects if `signal`
   * aborts first. The release is idempotent. */
  acquire(
    repo: string,
    perRepo: number,
    signal?: AbortSignal,
  ): Promise<Release> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Stopped while waiting to start."));
        return;
      }
      const waiter: Waiter = {
        repo,
        perRepo,
        resolve,
        reject,
        signal,
        onAbort: () => {
          this.queue = this.queue.filter((item) => item !== waiter);
          reject(new Error("Stopped while waiting to start."));
        },
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.queue.push(waiter);
      this.pump();
    });
  }

  /** Turns waiting, and turns running, for views and tests. */
  get state() {
    return { running: this.running, waiting: this.queue.length };
  }

  private pump() {
    for (const waiter of [...this.queue]) {
      if (this.running >= this.total) return;
      if ((this.byRepo.get(waiter.repo) ?? 0) >= waiter.perRepo) continue;
      this.queue = this.queue.filter((item) => item !== waiter);
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      this.running++;
      this.byRepo.set(waiter.repo, (this.byRepo.get(waiter.repo) ?? 0) + 1);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.running--;
        const left = (this.byRepo.get(waiter.repo) ?? 1) - 1;
        if (left <= 0) this.byRepo.delete(waiter.repo);
        else this.byRepo.set(waiter.repo, left);
        this.pump();
      });
    }
  }
}
