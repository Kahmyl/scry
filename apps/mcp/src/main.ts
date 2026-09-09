#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBrowserMcpServer } from "./server.js";

const server = createBrowserMcpServer();
await server.connect(new StdioServerTransport());
