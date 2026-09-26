import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@agentos/sdk', '@agentos/core', '@agentos/events'],
  // The dashboard is routinely opened on 127.0.0.1 as well as localhost during
  // development; without this, Next's dev server refuses to serve HMR and other
  // dev-only resources to the other spelling of the same host.
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
};

export default config;
