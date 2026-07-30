#!/usr/bin/env node
// stdio MCP server — for running fangornmd from a checkout on your own machine.
//
//   FANGORNMD_TOKEN=fmd_0x…   mint it in the browser: 🤖 button in the header
//   FANGORNMD_URL=http://localhost:8787
//
// If the server is hosted, prefer the HTTP transport it already exposes — no
// checkout and no Node needed on the agent's side:
//
//   claude mcp add --transport http fangornmd https://host/mcp \
//     --header "Authorization: Bearer fmd_0x…"
//
// The tools themselves live in tools.js, shared by both transports.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createFangornmdServer, httpCall } from "./tools.js";

const BASE = (process.env.FANGORNMD_URL ?? "http://localhost:8787").replace(/\/$/, "");
const TOKEN = process.env.FANGORNMD_TOKEN;

if (!TOKEN) {
    console.error("FANGORNMD_TOKEN is not set — mint one from the fangornmd header (🤖) and put it in your MCP config.");
    process.exit(1);
}

const server = createFangornmdServer({ call: httpCall(BASE, TOKEN), base: BASE });
await server.connect(new StdioServerTransport());
