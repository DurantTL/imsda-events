/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS preload for Node, not app code */
// Lets a command-line verification script import server modules. Next.js
// provides `server-only` to the server bundle; plain Node has no such package,
// and the guard it enforces (never ship to a browser) doesn't apply here.
const Module = require("node:module");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === "server-only") return require.resolve("./empty-module.cjs");
  return originalResolve.call(this, request, ...rest);
};
