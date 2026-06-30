import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root to this project (a parent lockfile exists at ~/).
  turbopack: { root: __dirname },
};

export default nextConfig;
