import { createServer } from "node:http";
import { resolve } from "node:path";
import { env, runtime, backends } from "./lib/state.mjs";
import { createApplicationServer } from "./lib/server.mjs";
import { comfyRequest, comfyBinaryRequest } from "./lib/comfy.mjs";
import { generateAgentContent } from "./lib/agent.mjs";
import { readLabHistory, saveLabHistory, readLabReferences, saveLabReferences } from "./lib/lab.mjs";

// Wire the swappable backends to their real implementations.
backends.comfyRequest = comfyRequest;
backends.comfyBinaryRequest = comfyBinaryRequest;
backends.generateAgentContent = generateAgentContent;
backends.readLabHistory = readLabHistory;
backends.saveLabHistory = saveLabHistory;
backends.readLabReferences = readLabReferences;
backends.saveLabReferences = saveLabReferences;

const args = process.argv.slice(2);
let host = "127.0.0.1";
let port = 8765;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--host" && args[index + 1]) host = args[++index];
  else if (args[index] === "--port" && args[index + 1]) port = Number(args[++index]);
  else if (args[index] === "--comfy-url" && args[index + 1]) runtime.comfyUiBaseUrl = String(args[++index]).replace(/\/+$/, "");
  else if (args[index] === "--token" && args[index + 1]) runtime.apiToken = String(args[++index]).trim();
}

const server = createApplicationServer();
server.listen(port, host, () => {
  console.log(`AITurboShow is available at http://${host}:${port}`);
  console.log(`Scanning story projects under ${env.repositoryRoot}`);
  console.log(`ComfyUI backend: ${runtime.comfyUiBaseUrl}`);
  console.log(runtime.apiToken ? "API token required for non-loopback clients." : "No API token set; loopback-only binding recommended.");
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
