import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit .next/standalone: the server, plus only the node_modules the traced
  // code actually reaches. It is what the Docker image copies, and it is why
  // the final image carries no package manager and no dependency install.
  output: "standalone",
};

export default nextConfig;
