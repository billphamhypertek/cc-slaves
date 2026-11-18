#!/usr/bin/env bun
// `bun fake-mcp/src/index.ts`: runs the fake MCP server (./server.ts) until killed and prints its base URLs, for manual
// probes of the engine proxy (`/mcp-proxy/<id>`) and the G3 OAuth work. Tests import `startFakeMcp` in-process instead.
import { startFakeMcp } from './server.ts';

const fake = startFakeMcp();
console.log(JSON.stringify({ v3: `${fake.origin}/v3/mcp`, v2: `${fake.origin}/v2/mcp`, sse: `${fake.origin}/sse` }));
