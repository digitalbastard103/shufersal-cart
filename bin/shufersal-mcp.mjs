#!/usr/bin/env node
// MCP launcher. Point your assistant at this file:
//   { "command": "node", "args": ["<path>/Shopping/bin/shufersal-mcp.mjs"] }
// It runs from the project folder (so .env, sessions/ and the saved session
// are found wherever the assistant starts it) and loads the TypeScript source
// directly - no build step. Nothing may be printed to stdout: that is the
// MCP channel.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
register();
await import('../src/mcp/main.ts');
