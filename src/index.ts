import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { removePidFile } from "./db/client.js";
import { DiscordClient } from "./discord/client.js";
import { toolRegistry } from "./mcp/tools/index.js";
import { MCP_SERVER_INSTRUCTIONS } from "./security/instructions.js";
import { getLogger } from "./shared/logger.js";

const logger = getLogger("main");

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
    instructions: MCP_SERVER_INSTRUCTIONS,
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
    {
      restartDiscord: (reason?: string) => discordClient.restart(reason),
    },
  );
});

// Main function
async function main() {
  try {
    // Start MCP server first
    logger.info("Starting MCP server...");
    const transport = new StdioServerTransport();
    await server.connect(transport);

    // Connect to Discord only after MCP is ready
    await discordClient.connect();

    logger.info("Discord Two-Way MCP server is running");
  } catch (error) {
    logger.error("Failed to start server:", error);
    await discordClient.disconnect();
    throw error;
  }
}

// Handle graceful shutdown
process.on("SIGINT", async () => {
  logger.info("Shutting down...");
  await discordClient.disconnect();
  process.exit(0);
});

// Handle transport close
process.on("SIGTERM", async () => {
  logger.info("Received SIGTERM, shutting down...");
  await discordClient.disconnect();
  process.exit(0);
});

// Safety net: remove PID file on exit (synchronous, runs even on unexpected exit)
process.on("exit", () => {
  removePidFile();
});

// Start the server
main().catch((error) => {
  logger.error("Fatal error:", error);
  process.exit(1);
});
