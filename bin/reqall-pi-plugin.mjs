#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2];

if (arg === '--help' || arg === '-h') {
  console.log('Usage: reqall-pi-plugin [--json]');
  console.log();
  console.log('Outputs the package root directory for pi install / diagnostics.');
  console.log();
  console.log('Options:');
  console.log('  --json   Print package.json with resolved directory path');
  console.log('  --help   Show this help message');
  process.exit(0);
}

if (arg === '--json') {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
  console.log(JSON.stringify({ ...manifest, dir: packageRoot }, null, 2));
  process.exit(0);
}

console.log(packageRoot);
