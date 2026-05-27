import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTpfMcpServer } from "./mcp-server.js";
import {
  analyzeBriefTool,
  answerContractQuestionsTool,
  generateScaffoldSessionTool,
  getBriefSessionTool,
  scaffoldFromBriefTool,
  startBriefSessionTool
} from "./service.js";

const server = createTpfMcpServer({
  analyzeBrief: analyzeBriefTool,
  scaffoldFromBrief: scaffoldFromBriefTool,
  startBriefSession: startBriefSessionTool,
  answerContractQuestions: answerContractQuestionsTool,
  getBriefSession: getBriefSessionTool,
  generateScaffold: generateScaffoldSessionTool
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

process.on("SIGINT", async () => {
  await server.close();
  process.exit(0);
});

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
