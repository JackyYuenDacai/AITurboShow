import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const libDirectory = dirname(fileURLToPath(import.meta.url));
const defaultToolDirectory = resolve(libDirectory, "..");

// Mutable environment so tests can sandbox the repository root.
export const env = {
  toolDirectory: defaultToolDirectory,
  repositoryRoot: resolve(defaultToolDirectory, ".."),
};

export const labHistoryPath = join(defaultToolDirectory, "lab-history.json");
export const labReferencesPath = join(defaultToolDirectory, "lab-references.json");
export const agentConfigPath = join(defaultToolDirectory, "config.local.json");
export const deepSeekH3SkillPath = join(defaultToolDirectory, "agent-skills", "minimax-h3-prompt-writing.md");
export const deepSeekH3PromptSkill = readFileSync(deepSeekH3SkillPath, "utf8").trim();

// Mutable runtime state that is reassigned across modules.
export const runtime = {
  generationQueueSequence: 0,
  processingVideoGenerationQueue: false,
  comfyUiBaseUrl: String(process.env.COMFYUI_URL || "http://127.0.0.1:8188").replace(/\/+$/, ""),
  apiToken: String(process.env.AITURBOSHOW_TOKEN || "").trim(),
  labHistorySync: null,
};

// Shared collections that are mutated (never reassigned) in place.
export const generationJobs = new Map();
export const activeAgentClipBatches = new Set();

// Swappable backends. The entry point wires these to the real implementations;
// tests replace them with mocks. Every cross-module call site goes through here.
export const backends = {
  comfyRequest: null,
  comfyBinaryRequest: null,
  generateAgentContent: null,
  readLabHistory: null,
  saveLabHistory: null,
  readLabReferences: null,
  saveLabReferences: null,
};
