/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  basePath: '/copilot',
  // Lint is available separately via `next lint`; it does not block the build.
  eslint: { ignoreDuringBuilds: true },
  // Docker builds set NEXT_OUTPUT=standalone; local dev/build stays untouched.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' } : {}),
};

module.exports = nextConfig;
