#!/usr/bin/env node

import { runServer } from './mcp/server';

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});