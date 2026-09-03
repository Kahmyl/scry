#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBrowserV2McpServer } from "./browser-v2-server.js";

const server = createBrowserV2McpServer();
await server.connect(new StdioServerTransport());
