import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
function fixture() {
  const root = fs.mkdtempSync(path.join(tmpdir(), "aiturboshow-references-"));
  const story = path.join(root, "story");
  const episode = path.join(story, "episode-01");
  const write = (relative, contents = "image") => {
    const destination = path.join(story, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
  };
  write("outline.md", "# Story");
  write("episode-01/outline.md", "# Episode");
  write("characters/prompts/hero.prompt", "Hero portrait");
  write("characters/images/hero.png");
  write("episode-01/reference-images/prompts/street.prompt", "Street");
  write("episode-01/reference-images/generated/street.png");
  write("episode-01/custom/extra.png");
  write("episode-01/custom/extra.prompt", "Extra scene");
  write("episode-01/custom/photo.jpg");
  write("episode-01/other/extra.png");
  const ref = (id, image, prompt) => ({ id, description: id, role: "reference", source: { type: "file", path: image, ...(prompt ? { prompt_path: prompt } : {}) } });
  const clips = [
    { clip_id: "clip-01", sequence: 1, path_base: "story", references: [
      ref("hero", "characters/images/hero.png"),
      ref("extra", "episode-01/custom/extra.png"),
      ref("photo", "episode-01/custom/photo.jpg"),
      ref("missing", "episode-01/custom/missing.png", "episode-01/custom/missing.prompt"),
      ref("street", "episode-01/reference-images/generated/street.png"),
      { id: "continuity", source: { type: "clip_artifact", clip_id: "clip-02", artifact: "last_frame" } },
      ref("outside", "../../outside.png"),
      ref("other-extra", "episode-01/other/extra.png"),
    ] },
    { clip_id: "clip-02", sequence: 2, path_base: "episode", references: [
      ref("extra-again", "custom/extra.png", "custom/extra.prompt"),
    ], outputs: { last_frame: { path: "generated/last.png" } } },
    { clip_id: "clip-03", sequence: 3, path_base: "repository", references: [
      ref("extra-third", "story/episode-01/custom/extra.png"),
    ] },
  ];
  for (const clip of clips) {
    clip.references.forEach((entry, index) => { entry.picture = index + 1; });
    write(`episode-01/${clip.clip_id}.json`, JSON.stringify(clip));
  }
  let source = fs.readFileSync(path.join(toolDirectory, "server.mjs"), "utf8")
    .replace(/^import .*;\r?\n/gm, "")
    .replace('const toolDirectory = dirname(fileURLToPath(import.meta.url));', `const toolDirectory = ${JSON.stringify(toolDirectory)};`)
    .replace('const repositoryRoot = resolve(toolDirectory, "..");', `const repositoryRoot = ${JSON.stringify(root)};`);
  source = source.slice(0, source.indexOf("const args = process.argv.slice(2);"));
  const context = vm.createContext({ ...fs, ...path, ...crypto, createServer, Buffer, process: { env: {} }, console });
  vm.runInContext(source + '\nglobalThis.api = {buildCatalog, manualClipReferences, updateReferenceContent, walk};', context);
  return { root, story, episode, api: context.api, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("episode discovery merges clip file inputs, deduplicates paths, and preserves dependencies", () => {
  const f = fixture();
  try {
    const filesBefore = f.api.walk(f.root).length;
    const story = f.api.buildCatalog().stories[0];
    const episode = story.episodes[0];
    assert.equal(story.references.length, 1);
    assert.equal(episode.references.length, 5); // indexed street + four unique clip images
    const extra = episode.references.find((ref) => ref.generation_path.endsWith("custom/extra.png"));
    assert.equal(extra.auto_discovered, true);
    assert.equal(extra.used_by.length, 3);
    assert.equal(extra.prompt_text, "Extra scene");
    assert.equal(extra.ready, true);
    assert.equal(episode.references.filter((ref) => ref.generation_path.endsWith("extra.png")).length, 2);
    assert.equal(episode.clips[0].references[0].source_id, story.references[0].id);
    assert.equal(episode.clips[0].references[1].source_id, extra.id);
    assert.equal(episode.clips[1].references[0].source_id, extra.id);
    assert.equal(episode.clips[0].references[5].dependency.clip_id, "clip-02");
    assert.equal(episode.references.some((ref) => ref.generation_path.includes("outside")), false);
    const missing = episode.references.find((ref) => ref.name === "missing");
    assert.equal(missing.ready, false);
    assert.equal(missing.prompt_text, "");
    assert.match(missing.upload_path, /custom\/missing.png$/);
    assert.equal(f.api.walk(f.root).length, filesBefore, "catalog reads must not index or rewrite files");
  } finally { f.close(); }
});

test("discovered references can be reused and missing prompts can be saved without rewriting clips", () => {
  const f = fixture();
  try {
    let story = f.api.buildCatalog().stories[0];
    let episode = story.episodes[0];
    const photo = episode.references.find((ref) => ref.name === "photo");
    const originalClip = fs.readFileSync(path.join(f.episode, "clip-01.json"), "utf8");
    const reused = f.api.manualClipReferences({ story, episode, storyDirectory: f.story }, [], 0, "i2va", { reference_ids: [photo.id] });
    assert.equal(reused[0].source.path, "episode-01/custom/photo.jpg");
    assert.match(reused[0].source.prompt_path, /reference-images\/prompts\/clip-ref-.*\.prompt$/);
    f.api.updateReferenceContent({ story_id: "story", episode_id: "episode-01", reference_id: photo.id, prompt_text: "Photo reference prompt" });
    story = f.api.buildCatalog().stories[0];
    episode = story.episodes[0];
    const restored = episode.references.find((ref) => ref.id === photo.id);
    assert.equal(restored.prompt_text, "Photo reference prompt\n");
    assert.equal(restored.generation_path, photo.generation_path);
    assert.equal(restored.images.length, 1);
    assert.equal(restored.auto_discovered, true);
    assert.equal(episode.references.length, 5);
    assert.equal(fs.readFileSync(path.join(f.episode, "clip-01.json"), "utf8"), originalClip);
    const missing = episode.references.find((ref) => ref.name === "missing");
    f.api.updateReferenceContent({ story_id: "story", episode_id: "episode-01", reference_id: missing.id, prompt_text: "A missing scene" });
    assert.equal(fs.readFileSync(path.join(f.episode, "custom/missing.prompt"), "utf8"), "A missing scene\n");
  } finally { f.close(); }
});

test("a declared first-frame anchor can use its clip's inline image prompt", () => {
  const f = fixture();
  try {
    const clipPath = path.join(f.episode, "clip-01.json");
    const clip = JSON.parse(fs.readFileSync(clipPath, "utf8"));
    clip.references[3].picture = 1;
    clip.references[3].role = "first_frame_anchor";
    clip.first_frame_image_prompt = "An opening view in soft light";
    fs.writeFileSync(clipPath, JSON.stringify(clip));
    const episode = f.api.buildCatalog().stories[0].episodes[0];
    const reference = episode.references.find((ref) => ref.name === "missing");
    assert.equal(reference.prompt_text, clip.first_frame_image_prompt);
    assert.equal(reference.prompt_origin, "clip-01:first_frame_image_prompt");
    assert.equal(fs.existsSync(path.join(f.root, reference.prompt_path)), false);
    f.api.updateReferenceContent({ story_id: "story", episode_id: "episode-01", reference_id: reference.id, prompt_text: "Revised opening view" });
    const updated = f.api.buildCatalog().stories[0].episodes[0].references.find((ref) => ref.id === reference.id);
    assert.equal(updated.prompt_text, "Revised opening view\n");
    assert.equal(updated.prompt_origin, undefined);
  } finally { f.close(); }
});

test("generated filename aliases keep their episode identity and inherit the matching image prompt", () => {
  const f = fixture();
  try {
    const clipPath = path.join(f.episode, "clip-03.json");
    const clip = JSON.parse(fs.readFileSync(clipPath, "utf8"));
    clip.references.push({ picture: 2, id: "hero-alias", description: "Hero turnaround", source: { type: "file", path: "story/characters/images/char_hero_turnaround.png" } });
    fs.writeFileSync(clipPath, JSON.stringify(clip));
    const before = f.api.buildCatalog().stories[0].episodes[0].references.find((ref) => ref.name === "Hero turnaround");
    assert.equal(before.ready, false);
    assert.equal(before.prompt_text, "Hero portrait");
    assert.equal(before.prompt_origin, "story/characters/prompts/hero.prompt");
    fs.writeFileSync(path.join(f.story, "characters/images/char_hero_turnaround.png"), "generated image");
    const catalog = f.api.buildCatalog();
    const after = catalog.stories[0].episodes[0].references.find((ref) => ref.id === before.id);
    assert.ok(after, "generation must not remove the episode reference");
    assert.equal(after.ready, true);
    assert.equal(after.generation_path, before.generation_path);
    assert.equal(after.prompt_text, before.prompt_text);
    assert.equal(catalog.stories[0].episodes[0].clips[2].references[1].source_id, before.id);
    fs.unlinkSync(path.join(f.story, "characters/images/char_hero_turnaround.png"));
    const missingAgain = f.api.buildCatalog().stories[0].episodes[0].references.find((ref) => ref.id === before.id);
    assert.equal(missingAgain.ready, false);
    fs.writeFileSync(path.join(f.story, "characters/prompts/hero-ref.prompt"), "Different hero");
    assert.equal(f.api.buildCatalog().stories[0].episodes[0].references.find((ref) => ref.id === before.id).prompt_text, "", "ambiguous aliases must not guess a prompt");
  } finally { f.close(); }
});

test("a clip image without prompt_path discovers its exact sibling prompt", () => {
  const f = fixture();
  try {
    const clipPath = path.join(f.episode, "clip-02.json");
    const clip = JSON.parse(fs.readFileSync(clipPath, "utf8"));
    delete clip.references[0].source.prompt_path;
    fs.writeFileSync(clipPath, JSON.stringify(clip));
    const ref = f.api.buildCatalog().stories[0].episodes[0].references.find((ref) => ref.name === "extra");
    assert.equal(ref.prompt_text, "Extra scene");
    assert.equal(ref.prompt_origin, "story/episode-01/custom/extra.prompt");
  } finally { f.close(); }
});
