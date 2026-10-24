#!/usr/bin/env node
import { buildProgram } from './program.js';

buildProgram()
  .parseAsync(process.argv)
  .catch((e: unknown) => {
    process.stderr.write(`speedpilot: ${(e as Error).message}\n`);
    process.exit(1);
  });
