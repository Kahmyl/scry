// Optional masking maintenance must never become browser-command admission.
// At most one unfinished task per page; deadlines do not enqueue replacements.
export class BestEffortTasks {
  constructor(warn, budgetMs = 200) {
    this.warn = warn;
    this.budgetMs = budgetMs;
    this.pending = new Map();
  }
  forget(key) {
    this.pending.delete(key);
  }
  async run(entries) {
    const tasks = entries.map(([key, fn]) => {
      if (!this.pending.has(key)) {
        const task = Promise.resolve()
          .then(fn)
          .catch(() => this.warn())
          .finally(() => {
            if (this.pending.get(key) === task) this.pending.delete(key);
          });
        this.pending.set(key, task);
      }
      return this.pending.get(key);
    });
    let timer;
    try {
      await Promise.race([
        Promise.all(tasks),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            this.warn();
            resolve();
          }, this.budgetMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
