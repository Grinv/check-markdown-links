#!/usr/bin/env node
import { run } from "../src/cli.ts";

const code = await run(process.argv.slice(2));
process.exit(code);
