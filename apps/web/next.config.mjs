/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The vertical-slice UI favours shipping over lint-perfection; lint is still
  // available via `next lint` but does not block the build.
  eslint: { ignoreDuringBuilds: true },
  // Docker builds set NEXT_OUTPUT=standalone; local dev/build stays untouched.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' } : {}),
};

export default nextConfig;
