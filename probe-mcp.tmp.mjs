import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const c = new Client({ name: "career-site-studio", version: "0.1.0" });
await c.connect(new StreamableHTTPClientTransport(new URL(process.env.TAVILY_MCP_URL)));
const r = await c.callTool({ name: "tavily_extract", arguments: { urls: ["https://example.invalid/nope"], extract_depth: "basic", format: "markdown" } });
console.log("failed_results:", JSON.stringify(r.structuredContent?.failed_results));
console.log("results len:", r.structuredContent?.results?.length);
await c.close();
