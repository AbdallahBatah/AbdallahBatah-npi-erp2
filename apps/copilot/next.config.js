/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  basePath: '/copilot',
  // Lint is available separately via `next lint`; it does not block the build.
  eslint: { ignoreDuringBuilds: true },
  // Docker builds set NEXT_OUTPUT=standalone; local dev/build stays untouched.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' } : {}),
  // pdfjs' own worker file and @napi-rs/canvas' native binding must be
  // loaded by Node from node_modules at runtime, not bundled by webpack.
  experimental: { serverComponentsExternalPackages: ['pdf-parse', 'pdfjs-dist', '@napi-rs/canvas', 'heic-convert'] },
};

module.exports = nextConfig;
