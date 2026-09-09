#!/usr/bin/env node
/**
 * Checks that the Figma MCP backend can authenticate and connect.
 *
 * Answers the two questions that actually go wrong — is there a usable token,
 * and does the server accept it — without needing a file key or a design. It
 * prints the token's length and 5-character prefix but never its value; the
 * prefix is the diagnostic that matters, because `figd_` means someone has
 * supplied a personal access token, which the hosted server always rejects.
 *
 *   npm run figma:check
 *   FIGMA_MCP_URL=http://127.0.0.1:3845/mcp npm run figma:check
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.join(ROOT, "..", "src");

// Same loader shim as scripts/smoke.mjs: the sources use "@/..." aliases and
// extensionless relative imports, which Node does not resolve on its own.
register(
  "data:text/javascript," +
    encodeURIComponent(`
      const SUFFIXES = ["", ".ts", ".tsx", "/index.ts", ".json"];
      export async function resolve(specifier, context, next) {
        const base = specifier.startsWith("@/")
          ? ${JSON.stringify(pathToFileURL(SRC + "/").href)} + specifier.slice(2)
          : specifier;
        const needsProbe = specifier.startsWith("@/") || specifier.startsWith(".");
        if (needsProbe) {
          let lastError;
          for (const suffix of SUFFIXES) {
            try {
              const resolved = await next(base + suffix, context);
              if (resolved.url.endsWith(".json")) {
                return { ...resolved, importAttributes: { type: "json" } };
              }
              return resolved;
            } catch (error) { lastError = error; }
          }
          throw lastError;
        }
        return next(specifier, context);
      }
    `),
  import.meta.url,
);

process.env.FIGMA_PROVIDER = "mcp";
process.env.FIGMA_MCP_URL ??= "https://mcp.figma.com/mcp";
const url = process.env.FIGMA_MCP_URL;

const { resolveFigmaMcpAuth, needsAuth, credentialsPath } = await import(
  pathToFileURL(path.join(SRC, "lib/providers/figma/mcp-auth.ts")).href
);
const { figmaStatus } = await import(
  pathToFileURL(path.join(SRC, "lib/providers/figma/index.ts")).href
);

console.log("target      :", url);
console.log("needs auth  :", needsAuth(url));
if (needsAuth(url)) console.log("token cache :", credentialsPath());

let auth;
try {
  auth = await resolveFigmaMcpAuth(url);
} catch (error) {
  console.error("\nFAIL: could not resolve a token.\n" + error.message);
  process.exit(1);
}

if (needsAuth(url)) {
  if (!auth) {
    console.error(
      "\nFAIL: no OAuth token found.\n" +
        "Run `claude`, connect the figma server with /mcp, then re-run this check.",
    );
    process.exit(1);
  }
  const prefix = auth.token.slice(0, 5);
  console.log(`token       : source=${auth.source}, ${auth.token.length} chars, prefix ${prefix}…`);
  if (prefix === "figd_") {
    console.error(
      "\nFAIL: that is a personal access token. The hosted MCP server only accepts OAuth tokens.",
    );
    process.exit(1);
  }
}
console.log("status      :", figmaStatus().detail);

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import(
  "@modelcontextprotocol/sdk/client/streamableHttp.js"
);

const client = new Client({ name: "career-site-studio", version: "0.1.0" });
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      fetch: auth
        ? (u, init) => {
            const headers = new Headers(init?.headers);
            headers.set("Authorization", `Bearer ${auth.token}`);
            return globalThis.fetch(u, { ...init, headers });
          }
        : undefined,
    }),
  );
} catch (error) {
  console.error(`\nFAIL: could not connect.\n${error.message}`);
  process.exit(1);
}

const { tools } = await client.listTools();
console.log(`\nconnected. ${tools.length} tools exposed.`);

// The provider matches tools by intent because Figma keeps renaming them, so
// the useful check is whether each intent still resolves against this server.
const INTENTS = {
  metadata: ["get_metadata", "design_context", "get_design", "metadata", "get_code"],
  variables: ["get_variable_defs", "variable", "get_design_tokens", "tokens"],
  image: ["get_screenshot", "get_image", "screenshot", "image"],
};

let missingRequired = false;
for (const [intent, fragments] of Object.entries(INTENTS)) {
  const hit = fragments
    .map((f) => tools.find((t) => t.name.toLowerCase().includes(f))?.name)
    .find(Boolean);
  console.log(`  ${intent.padEnd(9)} -> ${hit ?? "NONE"}`);
  // Only structure is load-bearing; variables and screenshots degrade to
  // warnings inside the provider, so their absence is not a failure here.
  if (!hit && intent === "metadata") missingRequired = true;
}

await client.close();

if (missingRequired) {
  console.error("\nFAIL: no structure tool — an import cannot derive frames from this server.");
  process.exit(1);
}
console.log("\nOK: the studio can import from this Figma MCP server.");
