import { open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { EventEmitter } from "node:events";
import {
  durableAppend,
  durableWrite,
  ensurePrivateDirectory,
  isNodeError,
} from "./durable-file.js";

export interface BrowserLike extends EventEmitter {
  isConnected(): boolean;
  close(): Promise<void>;
}

export interface BrowserContextLike extends EventEmitter {
  close(): Promise<void>;
}

function processAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch {
    return false;
  }
}

export class BrowserOwnerSupervisor<B extends BrowserLike, C extends BrowserContextLike> {
  readonly #directory: string;
  readonly #launchBrowser: () => Promise<B>;
  readonly #createContext: (browser: B, generation: number) => Promise<C>;
  readonly #prepareContext: (context: C, generation: number) => Promise<void>;
  #browser: B | null = null;
  #context: C | null = null;
  #generation = 0;
  #losses = 0;
  #creating: Promise<C> | null = null;
  #closing = false;
  #leaseHandle: Awaited<ReturnType<typeof open>> | null = null;
  readonly #lostGenerations = new Set<number>();

  constructor(options: {
    directory: string;
    launchBrowser: () => Promise<B>;
    createContext: (browser: B, generation: number) => Promise<C>;
    prepareContext: (context: C, generation: number) => Promise<void>;
  }) {
    this.#directory = options.directory;
    this.#launchBrowser = options.launchBrowser;
    this.#createContext = options.createContext;
    this.#prepareContext = options.prepareContext;
  }

  async initialize(): Promise<this> {
    await ensurePrivateDirectory(this.#directory);
    try {
      const epoch = JSON.parse(
        await readFile(path.join(this.#directory, "owner-epoch.json"), "utf8"),
      ) as { generation?: unknown };
      if (!Number.isInteger(epoch.generation) || (epoch.generation as number) < 0)
        throw new Error("owner_epoch_invalid");
      this.#generation = epoch.generation as number;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    await this.#acquireLease();
    await this.#record("supervisor_started", { generation: this.#generation });
    return this;
  }

  async getContext(): Promise<C> {
    if (this.#closing) throw new Error("browser_owner_supervisor_closing");
    if (this.#context) return this.#context;
    if (this.#creating) return this.#creating;
    this.#creating = this.#createOwner();
    try {
      return await this.#creating;
    } finally {
      this.#creating = null;
    }
  }

  status(): { generation: number; active: boolean; browserConnected: boolean; losses: number } {
    return {
      generation: this.#generation,
      active: this.#context !== null,
      browserConnected: this.#browser?.isConnected() ?? false,
      losses: this.#losses,
    };
  }

  async invalidate(reason = "owner_invalidated"): Promise<void> {
    if (this.#closing) return;
    const context = this.#context;
    this.#context = null;
    await this.#noteLoss(this.#generation, reason);
    if (context) await context.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    const context = this.#context;
    const browser = this.#browser;
    this.#context = null;
    this.#browser = null;
    if (context) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    await durableWrite(
      path.join(this.#directory, "owner-state.json"),
      JSON.stringify({
        state: "closed",
        generation: this.#generation,
        pid: process.pid,
        closedAt: new Date().toISOString(),
      }),
    );
    await this.#record("supervisor_closed", { generation: this.#generation });
    if (this.#leaseHandle) await this.#leaseHandle.close().catch(() => undefined);
    this.#leaseHandle = null;
    await unlink(path.join(this.#directory, ".browser-owner.lease")).catch(() => undefined);
  }

  async #createOwner(): Promise<C> {
    if (!this.#browser || !this.#browser.isConnected()) {
      this.#browser = await this.#launchBrowser();
      const observedBrowser = this.#browser;
      observedBrowser.once("disconnected", () => {
        if (this.#browser !== observedBrowser) return;
        const lostGeneration = this.#generation;
        this.#browser = null;
        this.#context = null;
        if (!this.#closing) void this.#noteLoss(lostGeneration, "browser_disconnected");
      });
    }
    this.#generation += 1;
    await durableWrite(
      path.join(this.#directory, "owner-epoch.json"),
      JSON.stringify({ generation: this.#generation }),
    );
    const generation = this.#generation;
    const context = await this.#createContext(this.#browser, generation);
    await this.#prepareContext(context, generation);
    this.#context = context;
    context.once("close", () => {
      if (this.#context !== context) return;
      this.#context = null;
      if (!this.#closing) void this.#noteLoss(generation, "context_lost");
    });
    await durableWrite(
      path.join(this.#directory, "owner-state.json"),
      JSON.stringify({
        state: "active",
        generation,
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }),
    );
    await this.#record("owner_created", { generation });
    return context;
  }

  async #acquireLease(): Promise<void> {
    const leasePath = path.join(this.#directory, ".browser-owner.lease");
    while (true) {
      try {
        this.#leaseHandle = await open(leasePath, "wx", 0o600);
        await this.#leaseHandle.writeFile(
          JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
        );
        await this.#leaseHandle.sync();
        return;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        let owner: { pid?: unknown } | null = null;
        try {
          owner = JSON.parse(await readFile(leasePath, "utf8")) as { pid?: unknown };
        } catch {
          owner = null;
        }
        if (owner && processAlive(owner.pid)) throw new Error("browser_owner_lease_conflict");
        await unlink(leasePath).catch(() => undefined);
      }
    }
  }

  async #noteLoss(generation: number, type: string): Promise<void> {
    const first = !this.#lostGenerations.has(generation);
    if (first) {
      this.#lostGenerations.add(generation);
      this.#losses += 1;
    }
    await this.#record(type, { generation, correlated: !first });
  }

  async #record(type: string, details: Record<string, unknown>): Promise<void> {
    await durableAppend(path.join(this.#directory, "owner-ledger.jsonl"), {
      at: new Date().toISOString(),
      pid: process.pid,
      type,
      ...details,
    });
  }
}
