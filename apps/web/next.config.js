const path = require('node:path');

/** @type {import('next').NextConfig} */
module.exports = {
  // Development renders run effects twice, so an effect without its cleanup shows at once.
  reactStrictMode: true,
  transpilePackages: ['@fieldsync/sync-core'],
  // The Docker image sets NEXT_OUTPUT=standalone; `next start` (local runs, e2e) uses the default output.
  output: process.env.NEXT_OUTPUT === 'standalone' ? 'standalone' : undefined,
  // Trace files from the monorepo root so the standalone output includes the workspace packages.
  experimental: { outputFileTracingRoot: path.join(__dirname, '../../') },
};
