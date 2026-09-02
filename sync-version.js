#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const packageJsonPath = path.join(__dirname, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const version = packageJson.version;

// manifest.json (MCPB) — top-level version
const manifestJsonPath = path.join(__dirname, 'manifest.json');
const manifestJson = JSON.parse(fs.readFileSync(manifestJsonPath, 'utf8'));
manifestJson.version = version;
fs.writeFileSync(manifestJsonPath, JSON.stringify(manifestJson, null, 2) + '\n');

// server.json (MCP registry) — top-level version + every package version
const serverJsonPath = path.join(__dirname, 'server.json');
if (fs.existsSync(serverJsonPath)) {
  const serverJson = JSON.parse(fs.readFileSync(serverJsonPath, 'utf8'));
  serverJson.version = version;
  for (const pkg of serverJson.packages ?? []) pkg.version = version;
  fs.writeFileSync(serverJsonPath, JSON.stringify(serverJson, null, 2) + '\n');
}

console.log(`✅ Synced version ${version} into manifest.json and server.json`);
