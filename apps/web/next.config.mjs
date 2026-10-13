/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The vertical-slice UI favours shipping over lint-perfection; lint is still
  // available via `next lint` but does not block the build.
  eslint: { ignoreDuringBuilds: true },
  // Docker builds set NEXT_OUTPUT=standalone; local dev/build stays untouched.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' } : {}),
  // The plant-monitoring and PPA sections are hidden (owner decision
  // 2026-10-12) but their pages stay in the tree. The app has no route guard,
  // so without these both URLs would still open for anyone who types them.
  async redirects() {
    return [
      { source: '/telemetry', destination: '/dashboard', permanent: false },
      { source: '/ppa', destination: '/dashboard', permanent: false },
    ];
  },
};

export default nextConfig;
