#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createScryMcpServer } from "./server.js";

const server = createScryMcpServer();
await server.connect(new StdioServerTransport());
