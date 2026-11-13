// At most one unfinished task per page in this lane; deadlines do not enqueue
// replacements. The caller separately owns fact admission and paint warnings.
export class BestEffortTasks {
  constructor(warn, budgetMs = 200, recovered = () => {}) {
    this.warn = warn;
    this.budgetMs = budgetMs;
    this.recovered = recovered;
    this.pending = new Map();
  }
  forget(key) {
    this.pending.delete(key);
  }
  async run(entries, budgetMs = this.budgetMs) {
    const tasks = entries.map(([key, fn]) => {
      if (!this.pending.has(key)) {
        const task = Promise.resolve()
          .then(fn)
          .then(() => this.recovered(key))
          .catch(() => this.warn("maintenance_failed", key))
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
            for (const [key] of entries)
              if (this.pending.has(key)) this.warn("maintenance_timeout", key);
            resolve();
          }, budgetMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
