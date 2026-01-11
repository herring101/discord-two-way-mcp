import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { DiscordClient } from "./discord-client.js";
import { toolRegistry } from "./tools/index.js";

// Initialize Discord client
const discordClient = new DiscordClient();

// Create MCP server instance
const server = new Server(
  {
    name: "discord-two-way-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Register tool list handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: toolRegistry.getDefinitions() };
});

// Register tool execution handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return toolRegistry.execute(
    name,
    discordClient.discordClient,
    (args as Record<string, unknown>) || {},
    discordClient.isReady,
  );
});

// Main function
async function main() {
  try {
    // Start MCP server first
    console.error("Starting MCP server...");
    const transport = new StdioServerTransport();
    await server.connect(transport);

    // Connect to Discord only after MCP is ready
    await discordClient.connect();

    console.error("Discord Two-Way MCP server is running");
  } catch (error) {
    console.error("Failed to start server:", error);
    await discordClient.disconnect();
    throw error;
  }
}

// Handle graceful shutdown
process.on("SIGINT", async () => {
  console.error("Shutting down...");
  await discordClient.disconnect();
  process.exit(0);
});

// Handle transport close
process.on("SIGTERM", async () => {
  console.error("Received SIGTERM, shutting down...");
  await discordClient.disconnect();
  process.exit(0);
});

// Start the server
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
