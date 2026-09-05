/** @type {import('next').NextConfig} */
const nextConfig = {
  // The MCP SDK and the Anthropic SDK are server-only; keep them out of the client bundle.
  serverExternalPackages: ["@modelcontextprotocol/sdk", "@anthropic-ai/sdk"],
};

export default nextConfig;
