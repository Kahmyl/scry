import { once } from "node:events";

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import type { AddressInfo } from "node:net";

import type {
  MaybePromise,
} from "../../core/types.js";

export interface BrowserFixtureRequest {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;

  readBody(): Promise<Buffer>;

  readJson<T = unknown>(): Promise<T>;
}

export type BrowserFixtureHandler = (
  request: BrowserFixtureRequest,
) => MaybePromise<boolean>;

export interface BrowserFixtureServer {
  origin: string;

  url(pathname: string): string;

  close(): Promise<void>;
}

export async function startBrowserFixtureServer(
  handlers: readonly BrowserFixtureHandler[],
): Promise<BrowserFixtureServer> {
  const server = createServer(
    (
      request,
      response,
    ) => {
      void dispatch(
        server,
        handlers,
        request,
        response,
      );
    },
  );

  server.listen(
    0,
    "127.0.0.1",
  );

  await once(
    server,
    "listening",
  );

  const address = server.address();

  if (
    !address ||
    typeof address === "string"
  ) {
    server.close();

    throw new Error(
      "ASSURANCE_BROWSER_FIXTURE_ADDRESS_UNAVAILABLE",
    );
  }

  const origin =
    `http://127.0.0.1:${(address as AddressInfo).port}`;

  return {
    origin,

    url(pathname: string): string {
      return new URL(
        pathname,
        origin,
      ).toString();
    },

    async close(): Promise<void> {
      if (!server.listening) {
        return;
      }

      const closed = once(
        server,
        "close",
      );

      server.close();

      await closed;
    },
  };
}

async function dispatch(
  server: Server,
  handlers: readonly BrowserFixtureHandler[],
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(
      request.url ?? "/",
      "http://fixture.invalid",
    );

    let body: Buffer | undefined;

    const readBody =
      async (): Promise<Buffer> => {
        if (body) {
          return body;
        }

        const chunks: Buffer[] = [];

        for await (
          const chunk of request
        ) {
          chunks.push(
            Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(chunk),
          );
        }

        body = Buffer.concat(chunks);

        return body;
      };

    const readJson =
      async <T>(): Promise<T> => {
        const raw =
          await readBody();

        return JSON.parse(
          raw.toString("utf8"),
        ) as T;
      };

    const context: BrowserFixtureRequest = {
      request,
      response,
      url,
      readBody,
      readJson,
    };

    for (const handler of handlers) {
      if (
        await handler(context)
      ) {
        return;
      }
    }

    if (!response.headersSent) {
      response.statusCode = 404;

      response.setHeader(
        "content-type",
        "text/plain; charset=utf-8",
      );
    }

    if (!response.writableEnded) {
      response.end("Not found");
    }
  } catch (error) {
    if (response.writableEnded) {
      return;
    }

    response.statusCode = 500;

    response.setHeader(
      "content-type",
      "application/json; charset=utf-8",
    );

    response.end(
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : String(error),
      }),
    );
  }
}
