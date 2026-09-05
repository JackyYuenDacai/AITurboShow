import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function pictureNumbers(prompt) {
  return [...new Set([...String(prompt || "").matchAll(/<Picture\s+(\d+)>/gi)].map((match) => Number(match[1])))].sort((a, b) => a - b);
}

function assertFieldsInOrder(clipId, prompt, fields) {
  let previous = -1;
  for (const field of fields) {
    const index = prompt.indexOf(field);
    assert(index >= 0, `${clipId}: missing Prompt field ${field}`);
    assert(index > previous, `${clipId}: Prompt field ${field} is out of order`);
    previous = index;
  }
}

const requestedDirectory = process.argv[2];
if (!requestedDirectory) {
  fail("Usage: node validate-clips.mjs <episode-directory>");
}

const episodeDirectory = resolve(process.cwd(), requestedDirectory);
assert(statSync(episodeDirectory).isDirectory(), `Not a directory: ${episodeDirectory}`);

const files = readdirSync(episodeDirectory)
  .filter((name) => /^clip[-_ ]?\d+\.json$/i.test(name))
  .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
assert(files.length > 0, `No structured clip JSON files found in ${episodeDirectory}`);

const records = files.map((name) => ({ name, payload: readJson(resolve(episodeDirectory, name)) }));
const byId = new Map();

for (const { name, payload } of records) {
  const label = payload.clip_id || name;
  assert(payload.schema_version === 1, `${label}: unsupported schema_version`);
  assert(typeof payload.clip_id === "string" && payload.clip_id.length > 0, `${name}: clip_id is required`);
  assert(!byId.has(payload.clip_id), `${payload.clip_id}: duplicate clip_id`);
  byId.set(payload.clip_id, payload);
  assert(Number.isInteger(payload.sequence) && payload.sequence > 0, `${label}: sequence must be a positive integer`);
  assert(typeof payload.title === "string" && payload.title.length > 0, `${label}: title is required`);
  assert(typeof payload.generation_mode === "string" && payload.generation_mode.length > 0, `${label}: generation_mode is required`);
  assert(typeof payload.duration_seconds === "number" && payload.duration_seconds > 0 && payload.duration_seconds <= 15, `${label}: duration_seconds must be greater than 0 and no more than 15`);
  assert(Array.isArray(payload.references), `${label}: references must be an array`);
  assert(payload.outputs && typeof payload.outputs === "object" && !Array.isArray(payload.outputs), `${label}: outputs must be an object`);

  const sockets = payload.references.map((entry) => entry.picture).filter(Number.isInteger);
  assert(new Set(sockets).size === sockets.length, `${label}: duplicate Picture socket`);
  assert(sockets.every((number, index) => number === index + 1), `${label}: Picture sockets must be consecutive and stored in order`);

  if (payload.generation_mode === "post") {
    assert(payload.video_prompt === null, `${label}: post-production clips must use video_prompt: null`);
    assert(typeof payload.post_production_instructions === "string" && payload.post_production_instructions.length > 0, `${label}: post-production instructions are required`);
  } else {
    assert(typeof payload.video_prompt === "string" && payload.video_prompt.length > 0, `${label}: video_prompt is required`);
    const usedPictures = pictureNumbers(payload.video_prompt);
    assert(JSON.stringify(usedPictures) === JSON.stringify(sockets), `${label}: Prompt pictures ${usedPictures} do not match JSON sockets ${sockets}`);
    if (payload.generation_mode === "ref2va") {
      assertFieldsInOrder(label, payload.video_prompt, ["subject_definitions:", "summary:", "retention_analysis:", "detailed_description:", "overall_soundscape:", "non_diegetic_music:"]);
    } else if (["t2va", "i2va", "fl2va", "l2va"].includes(payload.generation_mode)) {
      assertFieldsInOrder(label, payload.video_prompt, ["integrated_multimodal_description:", "overall_soundscape:", "non_diegetic_music:"]);
    }
  }

  for (const reference of payload.references) {
    assert(reference && typeof reference === "object", `${label}: invalid reference entry`);
    assert(typeof reference.id === "string" && reference.id.length > 0, `${label}: reference id is required`);
    assert(typeof reference.role === "string" && reference.role.length > 0, `${label}/${reference.id}: role is required`);
    assert(typeof reference.description === "string" && reference.description.length > 0, `${label}/${reference.id}: description is required`);
    assert(reference.source && typeof reference.source.type === "string", `${label}/${reference.id}: source.type is required`);
    if (reference.source.type === "file") {
      assert(typeof reference.source.path === "string" && reference.source.path.length > 0, `${label}/${reference.id}: file source path is required`);
    } else if (reference.source.type === "clip_artifact") {
      assert(typeof reference.source.clip_id === "string" && reference.source.clip_id.length > 0, `${label}/${reference.id}: source clip_id is required`);
      assert(typeof reference.source.artifact === "string" && reference.source.artifact.length > 0, `${label}/${reference.id}: source artifact is required`);
    }
  }

  for (const [artifactName, output] of Object.entries(payload.outputs)) {
    assert(output && typeof output.path === "string" && output.path.length > 0, `${label}: output ${artifactName} requires a path`);
    assert(typeof output.artifact_id === "string" && output.artifact_id.length > 0, `${label}: output ${artifactName} requires an artifact_id`);
  }
}

for (const { payload } of records) {
  for (const reference of payload.references) {
    if (reference.source?.type !== "clip_artifact") continue;
    const producer = byId.get(reference.source.clip_id);
    assert(producer, `${payload.clip_id}/${reference.id}: unknown source clip ${reference.source.clip_id}`);
    assert(producer.outputs?.[reference.source.artifact], `${payload.clip_id}/${reference.id}: ${reference.source.clip_id} does not declare output ${reference.source.artifact}`);
  }
}

const totalDuration = records.reduce((sum, record) => sum + record.payload.duration_seconds, 0);
process.stdout.write(`Validated ${records.length} clip records in ${basename(episodeDirectory)} (${totalDuration} seconds).\n`);
