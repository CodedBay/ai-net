#!/usr/bin/env node
/**
 * generate-openapi.js
 *
 * Generates docs/openapi.yaml from the live swagger-jsdoc spec exported by
 * src/api/docs.ts.  Run via:
 *
 *   npm run docs:generate
 *
 * The file is committed to the repo so that CI can diff it and fail when the
 * spec drifts from the routes.
 */

"use strict";

const path = require("path");
const fs = require("fs");

// Register ts-node so we can import TypeScript source directly.
require("ts-node").register({
  transpileOnly: true,
  // Use the project's own tsconfig so module resolution works correctly.
  project: path.join(__dirname, "../tsconfig.json"),
  // Silence ts-node's own logging.
  logError: false,
});

const { openapiSpec } = require(path.join(__dirname, "../src/api/docs/openapi"));
const YAML = require("yaml");

const outPath = path.join(__dirname, "../docs/openapi.yaml");
const yaml = YAML.stringify(openapiSpec, { lineWidth: 0 });

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, yaml, "utf8");

console.log(`✅  docs/openapi.yaml written (${fs.statSync(outPath).size} bytes)`);
