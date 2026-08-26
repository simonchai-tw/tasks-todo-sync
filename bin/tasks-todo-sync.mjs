#!/usr/bin/env node

import { main } from '../lib/cli.mjs';

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
