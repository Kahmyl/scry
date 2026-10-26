import { chromium, type Browser, type BrowserServer } from "playwright";

export interface OwnedBrowserOptions {
  headless?: boolean;
  channel?: string;
  executablePath?: string;
  launchTimeoutMs?: number;
  connectTimeoutMs?: number;
  gracefulCloseMs?: number;
  killTimeoutMs?: number;
}

export interface BrowserTerminationReceipt {
  readonly forced: boolean;
  readonly exitConfirmed: true;
}

function budget(value: number | undefined, fallback: number, maximum: number, allowZero = false) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < (allowZero ? 0 : 1) || result > maximum)
    throw new Error("SCRY_BROWSER_PROCESS_CONFIGURATION_INVALID");
  return result;
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("SCRY_BROWSER_PROCESS_TERMINATION_UNCONFIRMED")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Owns a local browser process, not merely a connection to it. A caller may
 * release execution authority only after an exit-confirmed receipt. Endpoint
 * credentials remain private. No authority is inferred from a timeout alone.
 */
export class OwnedBrowser {
  #disposal: Promise<BrowserTerminationReceipt> | undefined;
  #terminationState: "active" | "terminating" | "exited" | "unconfirmed" = "active";
  #forceRequested = false;
  #requestForce!: () => void;
  readonly #forced = new Promise<void>((resolve) => {
    this.#requestForce = resolve;
  });

  private constructor(
    readonly browser: Browser,
    private readonly server: BrowserServer,
    private readonly gracefulCloseMs: number,
    private readonly killTimeoutMs: number,
  ) {
    browser.once("disconnected", () => {
      if (this.#terminationState !== "active") return;
      // A lost control connection must not leave an autonomous child acting.
      // Retain a rejected disposal and explicit unconfirmed state for callers;
      // this observer prevents an unhandled background rejection, not a waiver.
      void this.terminate().catch(() => undefined);
    });
  }

  static async launch(options: OwnedBrowserOptions = {}): Promise<OwnedBrowser> {
    const launchTimeout = budget(options.launchTimeoutMs, 15000, 120000);
    const connectTimeout = budget(options.connectTimeoutMs, 5000, 30000);
    const grace = budget(options.gracefulCloseMs, 2000, 30000, true);
    const killTimeout = budget(options.killTimeoutMs, 5000, 30000);
    let server: BrowserServer;
    try {
      server = await chromium.launchServer({
        host: "127.0.0.1",
        port: 0,
        timeout: launchTimeout,
        headless: options.headless ?? true,
        ...(options.channel ? { channel: options.channel } : {}),
        ...(options.executablePath ? { executablePath: options.executablePath } : {}),
      });
    } catch {
      throw new Error("SCRY_BROWSER_PROCESS_LAUNCH_FAILED");
    }
    let code = "SCRY_BROWSER_PROCESS_CONNECT_FAILED";
    try {
      const endpointText = server.wsEndpoint();
      const endpoint = new URL(endpointText);
      if (
        endpoint.protocol !== "ws:" ||
        endpoint.hostname !== "127.0.0.1" ||
        !endpoint.port ||
        endpoint.username ||
        endpoint.password
      ) {
        code = "SCRY_BROWSER_PROCESS_ENDPOINT_INVALID";
        throw new Error(code);
      }
      const browser = await chromium.connect(endpointText, { timeout: connectTimeout });
      if (!browser.isConnected()) throw new Error(code);
      return new OwnedBrowser(browser, server, grace, killTimeout);
    } catch {
      // A failed client connection does not relinquish ownership of the child.
      await terminateServer(server, grace, killTimeout);
      throw new Error(code);
    }
  }

  get exitConfirmed(): boolean {
    return exited(this.server);
  }
  get terminationState(): "active" | "terminating" | "exited" | "unconfirmed" {
    return this.#terminationState;
  }

  close(): Promise<BrowserTerminationReceipt> {
    if (!this.#disposal) {
      this.#terminationState = "terminating";
      // Assign the shared operation before invoking driver callbacks, including
      // a synchronous disconnect emitted during close.
      this.#disposal = Promise.resolve()
        .then(() =>
          terminateServer(
            this.server,
            this.gracefulCloseMs,
            this.killTimeoutMs,
            this.#forceRequested,
            this.#forced,
          ),
        )
        .then(
          (receipt) => {
            this.#terminationState = "exited";
            return receipt;
          },
          () => {
            this.#terminationState = "unconfirmed";
            throw new Error("SCRY_BROWSER_PROCESS_TERMINATION_UNCONFIRMED");
          },
        );
    }
    return this.#disposal;
  }

  /** Escalates an already-running graceful close, rather than starting a second
   * disposal or waiting out an unrelated grace interval. */
  terminate(): Promise<BrowserTerminationReceipt> {
    this.#forceRequested = true;
    this.#requestForce();
    return this.close();
  }
}

function exited(server: BrowserServer): boolean {
  const child = server.process();
  return child.exitCode !== null || child.signalCode !== null;
}

async function terminateServer(
  server: BrowserServer,
  grace: number,
  killTimeout: number,
  force = false,
  forceRequested?: Promise<void>,
): Promise<BrowserTerminationReceipt> {
  let forced = force || grace === 0;
  if (!exited(server) && !forced) {
    try {
      const closing = server.close();
      await bounded(forceRequested ? Promise.race([closing, forceRequested]) : closing, grace);
    } catch {
      forced = true;
    }
  }
  if (!exited(server)) {
    forced = true;
    try {
      await bounded(server.kill(), killTimeout);
    } catch {
      throw new Error("SCRY_BROWSER_PROCESS_TERMINATION_UNCONFIRMED");
    }
  }
  if (!exited(server)) throw new Error("SCRY_BROWSER_PROCESS_TERMINATION_UNCONFIRMED");
  return Object.freeze({ forced, exitConfirmed: true });
}
