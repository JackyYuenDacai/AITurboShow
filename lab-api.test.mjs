import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

// Run the real API handlers with isolated history, reference storage, and ComfyUI.
// No production files, API keys, or generation services are changed by these tests.
const directory = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(directory, "..", "__lab-test.png");
let source = fs.readFileSync(path.join(directory, "server.mjs"), "utf8")
  .replace(/^import .*;\r?\n/gm, "")
  .replace('const toolDirectory = dirname(fileURLToPath(import.meta.url));', `const toolDirectory = ${JSON.stringify(directory)};`);
source = source.slice(0, source.indexOf("const args = process.argv.slice(2);"));

async function harness() {
  const state = { history: [], references: [], calls: [], records: {}, queue: { queue_running: [], queue_pending: [] }, drafts: [] };
  const context = vm.createContext({
    ...fs, ...path, ...crypto, createServer, fileURLToPath, Buffer, Blob, FormData, URL, URLSearchParams,
    AbortController, setTimeout, clearTimeout, process: { env: {} }, console: { log() {}, error() {} },
    statSync: (name) => path.resolve(name) === fixture ? { isFile: () => true, size: 10 } : fs.statSync(name),
    readFileSync: (name, encoding) => path.resolve(name) === fixture ? Buffer.from("image-data") : fs.readFileSync(name, encoding),
    state,
    mockComfy: async (url, options) => {
      state.calls.push({ url, options });
      if (url === "/upload/image") return { name: "staged.png", subfolder: "aiturboshow-lab" };
      if (url === "/prompt") return { prompt_id: `prompt-${state.calls.length}` };
      if (url === "/history") return state.records;
      if (url === "/queue") return state.queue;
      throw new Error(`Unexpected backend call: ${url}`);
    },
  });
  vm.runInContext(source + `
    readLabHistory = () => JSON.parse(JSON.stringify(state.history));
    saveLabHistory = (items) => { state.history = JSON.parse(JSON.stringify(items)); };
    readLabReferences = () => JSON.parse(JSON.stringify(state.references));
    saveLabReferences = (items) => { state.references = JSON.parse(JSON.stringify(items)); };
    comfyRequest = mockComfy;
    comfyBinaryRequest = async () => Buffer.from("output");
    generateAgentContent = async (payload) => { state.drafts.push(payload); return {content: "Draft", model: "test-model"}; };
    globalThis.application = createApplicationServer();
  `, context);
  await new Promise((resolve) => context.application.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${context.application.address().port}`;
  return {
    state,
    async call(endpoint, body, method = "POST") {
      const response = await fetch(base + endpoint, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = response.headers.get("content-type")?.includes("application/json") ? await response.json() : await response.text();
      return { status: response.status, data, type: response.headers.get("content-type") };
    },
    async close() { await new Promise((resolve) => context.application.close(resolve)); },
  };
}

test("lab API validates and queues images with reproducible settings", async () => {
  const h = await harness();
  try {
    for (const invalid of [{ width: 257 }, { steps: "abc" }, { seed: -1 }, { height: 4096 }, { steps: null }]) {
      assert.equal((await h.call("/api/lab/generate-image", { prompt: "Portrait", ...invalid })).status, 400);
    }
    assert.equal(h.state.calls.length, 0);
    const result = await h.call("/api/lab/generate-image", { prompt: "Portrait", width: 768, height: 1024, steps: 12, seed: 0 });
    assert.equal(result.status, 202);
    assert.equal(result.data.seed, 0);
    assert.equal(result.data.steps, 12);
    assert.equal(h.state.calls[0].options.body.prompt["8"].inputs.seed, 0);
    assert.equal(h.state.history.length, 1);
  } finally { await h.close(); }
});

test("video modes enforce sockets and stage selected repository images", async () => {
  const h = await harness();
  try {
    const ref = { picture: 1, image: "__lab-test.png", description: "Hero" };
    for (const invalid of [
      { video_mode: "i2va" }, { video_mode: "ref2va" },
      { video_mode: "t2va", references: [ref] }, { duration: 16 },
      { video_mode: "ref2va", references: [{ ...ref, picture: 2 }] },
      { video_mode: "i2va", references: [{ ...ref, image: "../outside.png" }] },
      { video_mode: "i2va", references: [ref] },
    ]) assert.equal((await h.call("/api/lab/generate-video", { video_prompt: "A scene", ...invalid })).status, 400);
    assert.equal(h.state.calls.length, 0);
    const result = await h.call("/api/lab/generate-video", { video_mode: "i2va", video_prompt: "Animate <Picture 1>.", references: [ref], duration: 10, options: { seed: 42 } });
    assert.equal(result.status, 202);
    assert.equal(result.data.video_mode, "i2va");
    assert.equal(result.data.references[0].image, "__lab-test.png");
    assert.equal(result.data.seed, 42);
    assert.equal(h.state.calls[0].url, "/upload/image");
    const prompt = h.state.calls[1].options.body.prompt;
    assert.equal(prompt["100"].inputs.image, "aiturboshow-lab/staged.png");
    assert.equal(prompt["15"].inputs.project_directory, directory);
    assert.equal(prompt["15"].inputs.path_base, "story");
    assert.match(prompt["15"].inputs.artifact_path, /^lab\//);
    const text = await h.call("/api/lab/generate-video", { video_mode: "t2va", video_prompt: "A scene", references: [] });
    assert.equal(text.status, 202);
    assert.equal(h.state.calls.at(-1).options.body.prompt["100"], undefined);
  } finally { await h.close(); }
});

test("rewrites pass usable editor references and reject missing library files", async () => {
  const h = await harness();
  try {
    const ref = { picture: 1, image: "__lab-test.png" };
    assert.equal((await h.call("/api/lab/rewrite", { mode: "image", prompt: "Portrait", instruction: "Soft light" })).status, 200);
    assert.equal(h.state.drafts[0].instruction, "Soft light");
    assert.equal((await h.call("/api/lab/rewrite", { mode: "video", video_mode: "i2va", prompt: "Animate", references: [ref] })).status, 200);
    const fields = h.state.drafts[1].fields;
    assert.equal(fields.video_prompt, "Animate");
    assert.equal(JSON.parse(fields.references)[0].image, ref.image);
    assert.equal((await h.call("/api/lab/references", { image: "missing.png" })).status, 400);
    assert.equal((await h.call("/api/lab/references", { image: ref.image, name: "Hero" })).status, 201);
    assert.equal(h.state.references.length, 1);
  } finally { await h.close(); }
});

test("history follows running, completed and failed jobs and serves matching media", async () => {
  const h = await harness();
  try {
    h.state.history = [
      { id: "v", kind: "video", prompt_id: "video", status: "queued" },
      { id: "i", kind: "image", prompt_id: "image", status: "queued" },
      { id: "e", kind: "video", prompt_id: "error", status: "queued" },
    ];
    h.state.queue.queue_running = [[0, "video"]];
    await h.call("/api/lab/history/sync", {});
    assert.equal(h.state.history[0].status, "running");
    h.state.records = {
      video: { status: { completed: true }, outputs: { a: { images: [{ filename: "last.png" }] }, b: { videos: [{ filename: "clip.webm" }] } } },
      image: { status: { status_str: "success" }, outputs: { a: { images: [{ filename: "portrait.png" }] } } },
      error: { status: { status_str: "error", messages: [["execution_error", { exception_message: "Out of memory" }]] } },
    };
    await h.call("/api/lab/history/sync", {});
    assert.equal(h.state.history[0].status, "completed");
    assert.equal(h.state.history[0].outputs.length, 1);
    assert.equal(h.state.history[0].outputs[0].filename, "clip.webm");
    assert.equal(h.state.history[1].status, "completed");
    assert.equal(h.state.history[2].error, "Out of memory");
    const media = await h.call(h.state.history[0].preview_urls[0], undefined, "GET");
    assert.equal(media.type, "video/webm");
    assert.equal((await h.call("/api/lab/output?prompt_id=video&filename=other.png", undefined, "GET")).status, 404);
  } finally { await h.close(); }
});
