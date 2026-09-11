import { createReadStream, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { backends, agentConfigPath, deepSeekH3PromptSkill } from "./state.mjs";
import { entries, isFile, readJson, relativePath, safeRepositoryPath } from "./fs-utils.mjs";
import { writeJsonAtomically, writeTextAtomically } from "./files.mjs";
import { buildCatalog, generatedReferenceDescription } from "./catalog.mjs";
import { assertH3PromptFormat, h3RequiresFirstFrameContinuity, withH3FirstFrameContinuity, resolveCatalogClip } from "./comfy.mjs";
import { structuredRecords, saveClipSequences, validateStructuredClipPayload, requiredSlug, markdownDocument, resolveCatalogEpisode } from "./content.mjs";
import { collectClipDependencyPlan } from "./generation.mjs";
import { httpError } from "./http.mjs";
import { agentActions, defaultDeepSeekBaseUrl, defaultDeepSeekModel, h3FirstFrameContinuityInstruction } from "./constants.mjs";

export function limitedText(value, maximum = 12000) {
  const text = String(value ?? "");
  return text.length <= maximum ? text : `${text.slice(0, maximum)}\n[truncated]`;
}

export function validateDeepSeekBaseUrl(value) {
  const raw = String(value || defaultDeepSeekBaseUrl).trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw httpError("DeepSeek base URL must be a valid HTTPS URL.", 400);
  }
  if (parsed.protocol !== "https:") throw httpError("DeepSeek base URL must use HTTPS.", 400);
  return raw;
}

export function readAgentConfig() {
  const stored = readJson(agentConfigPath) || {};
  const storedKey = String(stored.api_key || "").trim();
  const environmentKey = String(process.env.DEEPSEEK_API_KEY || "").trim();
  const apiKey = storedKey || environmentKey;
  const baseUrl = validateDeepSeekBaseUrl(stored.base_url || process.env.DEEPSEEK_BASE_URL || defaultDeepSeekBaseUrl);
  const model = String(stored.model || process.env.DEEPSEEK_MODEL || defaultDeepSeekModel).trim() || defaultDeepSeekModel;
  return {
    api_key: apiKey,
    api_key_source: storedKey ? "config.local.json" : environmentKey ? "environment" : "none",
    base_url: baseUrl,
    model,
  };
}

export function publicAgentConfig() {
  const config = readAgentConfig();
  const key = config.api_key;
  const maskedKey = key ? `${key.slice(0, Math.min(7, key.length))}${"•".repeat(Math.min(8, Math.max(4, key.length - 7)))}` : null;
  return {
    configured: Boolean(key),
    api_key_source: config.api_key_source,
    masked_api_key: maskedKey,
    base_url: config.base_url,
    model: config.model,
    config_path: relativePath(agentConfigPath),
  };
}

export function saveAgentConfig(payload) {
  const existing = readJson(agentConfigPath) || {};
  const next = {
    base_url: validateDeepSeekBaseUrl(payload.base_url ?? existing.base_url ?? defaultDeepSeekBaseUrl),
    model: String(payload.model ?? existing.model ?? defaultDeepSeekModel).trim(),
  };
  if (!next.model || next.model.length > 120 || !/^[a-zA-Z0-9._:/-]+$/.test(next.model)) {
    throw httpError("DeepSeek model name is invalid.", 400);
  }
  if (payload.clear_api_key === true) next.api_key = "";
  else if (String(payload.api_key || "").trim()) {
    const key = String(payload.api_key).trim();
    if (key.length > 512) throw httpError("DeepSeek API key is too long.", 400);
    next.api_key = key;
  } else next.api_key = String(existing.api_key || "").trim();
  writeJsonAtomically(agentConfigPath, next);
  return publicAgentConfig();
}

export function deepSeekChatUrl(baseUrl) {
  if (/\/chat\/completions$/i.test(baseUrl)) return baseUrl;
  return `${baseUrl}/chat/completions`;
}

export async function deepSeekComplete(messages, { maximumTokens = 4096, temperature = 0.7, jsonMode = false } = {}) {
  const config = readAgentConfig();
  if (!config.api_key) throw httpError("DeepSeek is not configured. Open DeepSeek settings and enter an API key.", 400);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(deepSeekChatUrl(config.base_url), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.api_key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature,
        max_tokens: maximumTokens,
        stream: false,
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: controller.signal,
    });
    const responseText = await response.text();
    let result = {};
    if (responseText) {
      try {
        result = JSON.parse(responseText);
      } catch {
        result = { raw: responseText };
      }
    }
    if (!response.ok) {
      const message = result.error?.message || result.message || result.raw || `HTTP ${response.status}`;
      if (/insufficient\s+balance|balance\s+is\s+insufficient/i.test(String(message))) {
        throw httpError("DeepSeek account has insufficient balance. Add API credits in the DeepSeek account, then retry.", 402);
      }
      throw httpError(`DeepSeek request failed: ${limitedText(message, 500)}`, response.status === 401 || response.status === 403 ? 401 : 502);
    }
    const content = result.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw httpError("DeepSeek returned an empty response.", 502);
    return {
      content: content.trim().replace(/^```(?:[a-z0-9_-]+)?\s*\n/i, "").replace(/\n```\s*$/i, "").trim(),
      model: result.model || config.model,
      usage: result.usage || null,
    };
  } catch (error) {
    if (error.status) throw error;
    if (error.name === "AbortError") throw httpError("DeepSeek request timed out after 120 seconds.", 504);
    throw httpError(`Could not reach DeepSeek at ${config.base_url}: ${error.message}`, 502);
  } finally {
    clearTimeout(timeout);
  }
}

export function compactReference(reference) {
  return {
    id: reference.id,
    name: reference.name,
    kind: reference.kind,
    scope: reference.scope,
    prompt: limitedText(reference.prompt_text, 1200),
    ready: Boolean(reference.ready),
  };
}

export function compactClip(clip) {
  return {
    id: clip.id,
    sequence: clip.sequence,
    title: clip.title,
    duration_seconds: clip.duration,
    generation_mode: clip.type,
    summary: clip.summary,
    video_prompt: limitedText(clip.structured_payload?.video_prompt || clip.prompt_text, 1800),
  };
}

export function buildAgentContext(payload) {
  const catalog = buildCatalog();
  const story = catalog.stories.find((candidate) => candidate.id === String(payload.story_id || "")) || null;
  const episode = story?.episodes?.find((candidate) => candidate.id === String(payload.episode_id || "")) || null;
  const clip = episode?.clips?.find((candidate) => candidate.id === String(payload.clip_id || "")) || null;
  const requestedClipIds = Array.isArray(payload.clip_ids) ? [...new Set(payload.clip_ids.map((value) => String(value)))] : [];
  const selectedClips = requestedClipIds.map((clipId) => episode?.clips?.find((candidate) => candidate.id === clipId)).filter(Boolean);
  const allowedFields = [
    "title", "summary", "outline_text", "duration_seconds", "generation_mode", "video_prompt",
    "first_frame_image_prompt", "post_production_instructions", "references", "outputs", "kind", "scope", "slug", "prompt_text",
    "max_clips", "prefer_previous_frame",
  ];
  const fields = {};
  for (const name of allowedFields) {
    if (payload.fields?.[name] === undefined) continue;
    fields[name] = ["number", "boolean"].includes(typeof payload.fields[name])
      ? payload.fields[name]
      : limitedText(payload.fields[name], name === "references" ? 14000 : 8000);
  }
  return {
    request: {
      action: payload.action,
      extra_direction: limitedText(payload.instruction, 4000),
      current_editor_fields: fields,
    },
    story: story ? {
      id: story.id,
      title: story.title,
      summary: story.summary,
      outline: limitedText(story.outline_text, 12000),
      references: (story.references || []).slice(0, 30).map(compactReference),
      episodes: (story.episodes || []).slice(0, 40).map((candidate) => ({
        id: candidate.id,
        number: candidate.number,
        title: candidate.title,
        summary: candidate.summary,
        clip_count: candidate.clip_count,
      })),
    } : null,
    episode: episode ? {
      id: episode.id,
      title: episode.title,
      summary: episode.summary,
      outline: limitedText(episode.outline_text, 12000),
      references: (episode.references || []).slice(0, 30).map(compactReference),
      clips: (episode.clips || []).slice(0, 40).map(compactClip),
    } : null,
    selected_clip: clip ? {
      ...compactClip(clip),
      structured_payload: clip.structured_payload ? {
        ...clip.structured_payload,
        video_prompt: limitedText(clip.structured_payload.video_prompt, 8000),
      } : null,
    } : null,
    selected_clips: selectedClips.map((candidate) => ({
      ...compactClip(candidate),
      structured_payload: candidate.structured_payload ? {
        ...candidate.structured_payload,
        video_prompt: limitedText(candidate.structured_payload.video_prompt, 10000),
      } : null,
    })),
  };
}

export function agentReferenceSockets(context) {
  const editorReferences = context.request.current_editor_fields.references;
  if (Array.isArray(editorReferences)) return editorReferences;
  if (typeof editorReferences === "string" && editorReferences.trim()) {
    try {
      const parsed = JSON.parse(editorReferences);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Saving the editor will report malformed reference JSON separately.
    }
  }
  return Array.isArray(context.selected_clip?.structured_payload?.references)
    ? context.selected_clip.structured_payload.references
    : [];
}

export function agentActionInstruction(action, context) {
  const title = context.request.current_editor_fields.title || context.episode?.title || context.story?.title || "Untitled";
  const mode = context.request.current_editor_fields.generation_mode || context.selected_clip?.generation_mode || "ref2va";
  const requestedDuration = Number(context.request.current_editor_fields.duration_seconds || context.selected_clip?.duration_seconds || 10);
  const duration = Number.isFinite(requestedDuration) && requestedDuration > 0 ? Math.min(requestedDuration, 15) : 10;
  const referenceSockets = agentReferenceSockets(context);
  const pictureNumbers = [...new Set(referenceSockets.map((reference) => Number(reference?.picture)).filter(Number.isInteger))].sort((a, b) => a - b);
  const continuityRequired = h3RequiresFirstFrameContinuity(referenceSockets, mode);
  const pictureRule = pictureNumbers.length
    ? `Use every and only these available picture sockets: ${pictureNumbers.map((number) => `<Picture ${number}>`).join(", ")}.`
    : "No picture sockets are currently declared. Do not invent any <Picture N> labels.";
  const promptBatchClipIds = (context.selected_clips || []).map((clip) => clip.id);
  const instructions = {
    story_summary: "Write a concise production-ready story summary in one to three paragraphs. Establish the premise, world, central characters, conflict, and trajectory. Return only the summary without a heading.",
    story_outline: `Write or revise the complete Markdown story outline. The first line must be \"# ${title}\". Include premise, themes, world rules, major characters, story arc, and episode direction. Preserve useful supplied facts and improve incomplete areas. Return only Markdown.`,
    episode_summary: "Write a concise episode summary in one to three paragraphs. State the opening situation, main escalation, turning point, ending state, and continuity into adjacent episodes. Return only the summary without a heading.",
    episode_outline: `Write or revise the complete Markdown episode outline. The first line must be \"# ${title}\". This is a production plan, not prose-only treatment: after a concise Episode Goal and Continuity section, include a heading exactly named \"## Clip allocation\". Under it, provide every planned clip in playback order with one Markdown subheading per clip, using \"### Clip 01 — <short title>\" (use an existing clip ID such as \"### clip-01 — <short title>\" when known). For every clip state: **Duration** (normally 10 seconds, never over 15), **What happens** (the exact story action or dialogue), **Visual / camera beat** (the view, movement, and transition), **Audio / dialogue**, **Purpose** (what this clip advances), and **Continuity** (how it begins from or hands off to adjacent clips). Include enough clips to cover the full episode, split any longer scene, speech, or action across sequential clips, and never leave a beat as an unallocated paragraph. Then include \"## Production requirements\" with the characters, environments, objects, and references needed. Preserve existing clip IDs, facts, and known continuity when present. Return only Markdown.`,
    clip_prompt: mode === "ref2va"
      ? `Write a MiniMax H3 Ref2VA prompt for a ${duration}-second clip. ${continuityRequired ? `The first line MUST be exactly: ${h3FirstFrameContinuityInstruction} Put one blank line after it.` : "Do not add a first-frame alignment line unless the supplied reference sockets declare a first-frame anchor."} Then use exactly these six colon-terminated fields in order: subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music. Do not write a preface, \"six-section structure:\", or bracketed section headings. Keep labels consistent, explicitly begin [Shot 1] from <Picture 1> when continuity is required, describe shots in playback order, and fit all timing inside ${duration} seconds. ${pictureRule} Return only the final prompt.`
      : mode === "i2va"
        ? `Write a MiniMax H3 I2VA prompt for a ${duration}-second clip. ${pictureNumbers.includes(1) ? `The first line MUST be exactly: ${h3FirstFrameContinuityInstruction} Put one blank line after it.` : "Because no first-frame socket is declared, do not invent an alignment instruction or picture label."} Then use exactly the colon-terminated fields integrated_multimodal_description, overall_soundscape, and non_diegetic_music in that order. Explicitly begin [Shot 1] from <Picture 1>, preserve its complete visible state at 0.00 seconds, and develop forward continuously. Fit every cut time inside ${duration} seconds. ${pictureRule} Return only the final prompt.`
        : mode === "t2va" || mode === "t2v"
          ? `Write a MiniMax H3 T2VA prompt for a ${duration}-second text-to-video clip. Use exactly these colon-terminated fields in order: integrated_multimodal_description, overall_soundscape, non_diegetic_music. Build a complete audiovisual timeline with shot composition, subjects, actions, camera, dialogue, and diegetic sound. Fit every cut time inside ${duration} seconds. Do not include picture labels or alignment instructions. Return only the final prompt.`
          : "Write precise post-production instructions for this clip, covering source inputs, edit operations, timing, transitions, audio, and required outputs. Return only the instructions.",
    clip_prompt_batch: `Rewrite the MiniMax H3 video_prompt for every supplied selected_clips entry and return only valid JSON with this exact shape: {"clips":[{"clip_id":"clip-01","video_prompt":"..."}]}. Return exactly these clip IDs once each and no others: ${promptBatchClipIds.join(", ")}. Preserve each clip's generation_mode, duration_seconds, reference order, literal <Picture N> socket set, story facts, dialogue language, and continuity relationship. Each video_prompt must be one complete replacement, not the old prompt followed by a revision. For Ref2VA use the exact six-field format from the skill. For I2VA use its exact three-field format. Whenever Picture 1 is a first-frame anchor or previous clip last frame, begin with the exact 0.00-second continuity sentence required by the skill. Do not change clip IDs, titles, references, outputs, or return any fields other than clip_id and video_prompt.`,
    first_frame_prompt: "Write a single production-ready image-generation prompt for the clip's opening frame. Specify composition, subjects, identity anchors, wardrobe, environment, lighting, lens/camera angle, and exact starting action state. Avoid motion that cannot exist in a still image. Return only the prompt.",
    post_production_instructions: "Write precise post-production instructions covering source inputs, edit operations, order, timing, transitions, typography if any, sound treatment, and output requirements. Return only the instructions.",
    reference_image_prompt: "Write a production-ready Z-Image Turbo reference-image prompt. Isolate and clearly describe the requested character, environment, or object; specify form, materials, colors, identity anchors, lighting, camera, and a clean useful composition. Avoid unnecessary borders, mockup frames, captions, watermarks, and unrelated objects. Return only the prompt.",
    episode_clip_batch: `Create the next production clips that are not already covered by the episode's existing clips. Return only valid JSON with this exact top-level shape: {"new_references":[],"clips":[]}.
Create no more than ${Math.max(1, Math.min(8, Number(context.request.current_editor_fields.max_clips) || 6))} clips. Each clip object must contain title, duration_seconds, generation_mode, use_previous_frame, reference_ids, video_prompt, first_frame_image_prompt, and post_production_instructions. generation_mode must be ref2va, i2va, or post. Prefer 10 seconds and never exceed 15 seconds. Split longer dialogue or actions across sequential clips.
First reuse equivalent references from the supplied story and episode reference lists. Only when a needed character, environment, object, or episode-specific visual does not already have an equivalent reference, propose it in new_references. Propose no more than 12 references and do not propose unused references. Each new reference must contain scope, kind, slug, and prompt_text. Use scope "story" for persistent reusable references and kind "character", "environment", or "object". Use scope "episode" and kind "episode reference" for visuals needed only by this episode. slug must use lowercase letters, numbers, and single hyphens. prompt_text must be a complete production-ready Z-Image Turbo prompt with a clean useful composition and no captions, watermarks, mockup borders, or unrelated objects.
Every clip reference_ids entry must be either an exact supplied reference ID or one of these deterministic proposed IDs: story:character:<slug>, story:environment:<slug>, story:object:<slug>, episode:episode reference:<slug>. For an episode-scoped visual, always use episode:episode reference:<slug> even when the visual depicts a character, environment, or object; never use episode:environment:<slug>, episode:character:<slug>, or episode:object:<slug>. If a clip needs an ID that is not in the supplied lists, add the matching complete entry to new_references instead of returning an unknown ID. Before returning JSON, verify that every reference_ids value resolves to either a supplied reference or a new_references deterministic ID. Attach every proposed reference to at least one clip. Proposed references create prompt records only; do not assume their PNG images already exist.
Use at most 9 picture inputs total. If use_previous_frame is true, <Picture 1> is reserved for the preceding clip's last frame and selected reference IDs begin at <Picture 2>. ${context.request.current_editor_fields.prefer_previous_frame === false ? "Use previous-frame continuity only when essential." : "Prefer previous-frame continuity between sequential clips when it is compatible with the scene."} For every non-post clip whose use_previous_frame is true, including Ref2VA, video_prompt MUST begin with this exact line: ${h3FirstFrameContinuityInstruction} Put exactly one blank line after it, and make [Shot 1] begin from the complete visible state of <Picture 1>. For I2VA, use exactly one picture input—either the previous frame or one reference ID, but not both—and always use that exact first-frame line. For Ref2VA, use exactly the colon-terminated fields subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, and non_diegetic_music in that order; never use bracketed headings or a \"six-section structure:\" preface. Use every declared <Picture N> exactly. Cite every literal <Picture N> token in subject_definitions and again where that reference takes effect in detailed_description. For I2VA, follow the first-frame line with exactly integrated_multimodal_description, overall_soundscape, and non_diegetic_music. Before returning JSON, count the previous-frame input plus reference_ids in each non-post clip and verify that video_prompt contains every and only the corresponding literal <Picture 1> through <Picture N> tags. For post mode, video_prompt must be null and post_production_instructions must be detailed. Continue from existing clips without duplicating their content.`,
  };
  return instructions[action];
}

export async function generateAgentContent(payload) {
  const action = String(payload.action || "");
  if (!agentActions.has(action)) throw httpError("Unknown agent action.", 400);
  const context = buildAgentContext({ ...payload, action });
  const system = [
    "You are the AITurboShow production-writing agent.",
    "Use only the supplied production context plus reasonable creative elaboration that does not contradict it.",
    "MiniMax H3 has a hard maximum duration of 15 seconds for one generated clip, and its preferred sweet spot is approximately 10 seconds. Never propose or describe one H3 clip longer than 15 seconds. Split longer story beats, dialogue, and actions into sequential clips, normally targeting 10 seconds each.",
    "Honor the requested language when the extra direction asks for one; otherwise follow the language already used in the project, while MiniMax H3 structural field names remain English.",
    "Return only the requested deliverable. Do not add analysis, explanations, preambles, quotations around the whole result, or Markdown code fences.",
    action === "clip_prompt" ? "Return one complete replacement prompt for the target video_prompt field. The existing prompt is context only: do not repeat it and then append a second version, do not provide before/after variants, and do not return multiple candidate prompts." : "",
    ["clip_prompt", "clip_prompt_batch", "episode_clip_batch"].includes(action) ? `Apply this MiniMax H3 prompt-writing skill exactly:\n\n${deepSeekH3PromptSkill}` : "",
    agentActionInstruction(action, context),
  ].filter(Boolean).join("\n");
  const contextForUser = action === "clip_prompt_batch" && context.episode
    ? {
        ...context,
        episode: {
          ...context.episode,
          clips: (context.episode.clips || []).map(({ video_prompt, ...clipSummary }) => clipSummary),
        },
      }
    : context;
  const contextLimit = action === "clip_prompt_batch" ? 140000 : 50000;
  const user = `Production context:\n${limitedText(JSON.stringify(contextForUser, null, 2), contextLimit)}`;
  const result = await deepSeekComplete([
    { role: "system", content: system },
    { role: "user", content: user },
  ], {
    maximumTokens: ["episode_clip_batch", "clip_prompt_batch"].includes(action) ? 8192 : action === "clip_prompt" || action.endsWith("outline") ? 4096 : 2048,
    temperature: ["episode_clip_batch", "clip_prompt_batch"].includes(action) ? 0.2 : 0.7,
    jsonMode: ["episode_clip_batch", "clip_prompt_batch"].includes(action),
  });
  if (action === "clip_prompt") {
    const mode = context.request.current_editor_fields.generation_mode || context.selected_clip?.generation_mode || "ref2va";
    if (["ref2va", "i2va"].includes(mode)) {
      const referenceSockets = agentReferenceSockets(context);
      const continuityRequired = h3RequiresFirstFrameContinuity(referenceSockets, mode);
      const content = withH3FirstFrameContinuity(result.content, continuityRequired);
      assertH3PromptFormat(content, mode, continuityRequired);
      const pictureNumbers = [...new Set(referenceSockets.map((reference) => Number(reference?.picture)).filter(Number.isInteger))].sort((a, b) => a - b);
      const usedPictures = [...new Set([...content.matchAll(/<Picture\s+(\d+)>/gi)].map((match) => Number(match[1])))].sort((a, b) => a - b);
      if (JSON.stringify(usedPictures) !== JSON.stringify(pictureNumbers)) {
        throw httpError(`DeepSeek prompt picture tags ${JSON.stringify(usedPictures)} do not match reference sockets ${JSON.stringify(pictureNumbers)}.`, 502);
      }
      return { action, ...result, content };
    }
  }
  return { action, ...result };
}

export function parseAgentJsonObject(content) {
  const text = String(content || "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1));
      } catch {
        // Fall through to a useful API error below.
      }
    }
  }
  throw httpError("DeepSeek returned an invalid clip-plan JSON document. Retry the batch or reduce the requested clip count.", 502);
}

export async function generateBatchClipPromptPreview(payload) {
  const target = resolveCatalogEpisode(payload);
  const requestedIds = Array.isArray(payload.clip_ids) ? [...new Set(payload.clip_ids.map((value) => String(value)))] : [];
  if (!requestedIds.length) throw httpError("Select at least one clip for batch prompt regeneration.", 400);
  const clipsById = new Map((target.episode.clips || []).map((clip) => [clip.id, clip]));
  const requestedClips = requestedIds.map((clipId) => {
    const clip = clipsById.get(clipId);
    if (!clip) throw httpError(`Unknown clip_id for prompt regeneration: ${clipId}`, 404);
    if (!clip.structured_payload || !["ref2va", "i2va"].includes(clip.type)) {
      throw httpError(`${clipId} is not a structured Ref2VA or I2VA clip.`, 400);
    }
    return clip;
  });
  const plannedClips = new Map();
  for (const clip of requestedClips) {
    const clipTarget = resolveCatalogClip({ story_id: target.story.id, episode_id: target.episode.id, clip_id: clip.id });
    if (payload.include_dependency_chain === true) collectClipDependencyPlan(clipTarget, plannedClips);
    else plannedClips.set(`${target.story.id}:${target.episode.id}:${clip.id}`, clip);
  }
  const planned = [...plannedClips.values()].sort((left, right) => left.sequence - right.sequence);
  if (planned.length > 8) throw httpError("Batch prompt regeneration supports at most 8 clips at once. Choose an earlier target or regenerate the chain in sections.", 400);
  const expandedClipIds = planned.map((clip) => clip.id);
  const previews = [];
  const models = new Set();
  const usage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  for (const [index, clip] of planned.entries()) {
    const original = clip.structured_payload;
    let generated = null;
    let previousError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const correction = previousError
        ? `The previous replacement prompt was rejected by deterministic validation: ${previousError.message}\nReturn one corrected complete replacement prompt only.`
        : "";
      try {
        generated = await backends.generateAgentContent({
          action: "clip_prompt",
          story_id: target.story.id,
          episode_id: target.episode.id,
          clip_id: clip.id,
          instruction: [
            `This is clip ${index + 1} of ${planned.length} in dependency-expanded batch ${expandedClipIds.join(" -> ")}.`,
            correction,
            payload.instruction,
          ].filter(Boolean).join("\n\n"),
          fields: {
            generation_mode: clip.type,
            duration_seconds: clip.duration,
            video_prompt: original.video_prompt,
            references: JSON.stringify(original.references, null, 2),
          },
        });
        const continuityRequired = h3RequiresFirstFrameContinuity(original.references, original.generation_mode);
        const videoPrompt = withH3FirstFrameContinuity(generated.content, continuityRequired);
        const updated = validateStructuredClipPayload(
          { ...original, video_prompt: videoPrompt },
          original,
          target.storyDirectory,
          target.episodeDirectory,
        );
        previews.push({
          clip_id: clip.id,
          sequence: clip.sequence,
          title: clip.title,
          generation_mode: clip.type,
          duration_seconds: clip.duration,
          video_prompt: updated.video_prompt,
        });
        if (generated.model) models.add(generated.model);
        for (const key of Object.keys(usage)) usage[key] += Number(generated.usage?.[key] || 0);
        previousError = null;
        break;
      } catch (error) {
        previousError = error;
        if (attempt === 2 || ![400, 502].includes(Number(error.status))) throw error;
      }
    }
    if (previousError) throw previousError;
  }
  return {
    story_id: target.story.id,
    episode_id: target.episode.id,
    include_dependency_chain: payload.include_dependency_chain === true,
    requested_clip_ids: requestedIds,
    expanded_clip_ids: previews.map((clip) => clip.clip_id),
    prompt_count: previews.length,
    clips: previews,
    model: [...models].join(", "),
    usage,
  };
}

export function updateClipPromptsContent(payload) {
  const target = resolveCatalogEpisode(payload);
  if (!Array.isArray(payload.prompts) || !payload.prompts.length) throw httpError("prompts must be a non-empty array.", 400);
  if (payload.prompts.length > 8) throw httpError("At most 8 clip prompts can be saved at once.", 400);
  const recordsById = new Map(structuredRecords(target.episodeDirectory).map((record) => [record.payload.clip_id, record]));
  const seen = new Set();
  const validated = payload.prompts.map((entry) => {
    const clipId = String(entry?.clip_id || "");
    if (!clipId || seen.has(clipId)) throw httpError("Each prompt entry requires a unique clip_id.", 400);
    seen.add(clipId);
    const record = recordsById.get(clipId);
    if (!record) throw httpError(`Unknown structured clip_id: ${clipId}`, 404);
    const original = readJson(record.path);
    if (!original || !["ref2va", "i2va"].includes(original.generation_mode)) {
      throw httpError(`${clipId} does not support an H3 video prompt.`, 400);
    }
    const continuityRequired = h3RequiresFirstFrameContinuity(original.references, original.generation_mode);
    const videoPrompt = withH3FirstFrameContinuity(String(entry.video_prompt || "").trim(), continuityRequired);
    return {
      path: record.path,
      payload: validateStructuredClipPayload(
        { ...original, video_prompt: videoPrompt },
        original,
        target.storyDirectory,
        target.episodeDirectory,
      ),
    };
  });
  validated.forEach((record) => writeJsonAtomically(record.path, record.payload));
  return {
    story_id: target.story.id,
    episode_id: target.episode.id,
    updated_count: validated.length,
    clip_ids: validated.map((record) => record.payload.clip_id),
  };
}

export function normalizedReferenceSlug(value, fallback) {
  const slug = String(value || fallback || "reference")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
  return slug || "reference";
}

export function proposedReferenceRecord(target, entry, index) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw httpError(`DeepSeek new reference ${index + 1} is invalid.`, 502);
  }
  const scope = String(entry.scope || "").trim();
  const slug = requiredSlug(entry.slug, `DeepSeek new reference ${index + 1} slug`);
  const promptText = String(entry.prompt_text || "").trim();
  if (!promptText) throw httpError(`DeepSeek new reference ${index + 1} is missing prompt_text.`, 502);

  let kind;
  let base;
  if (scope === "story") {
    const directoryByKind = { character: "characters", environment: "environments", object: "objects" };
    kind = String(entry.kind || "").trim();
    if (!directoryByKind[kind]) {
      throw httpError(`DeepSeek new story reference ${index + 1} kind must be character, environment, or object.`, 502);
    }
    base = join(target.storyDirectory, directoryByKind[kind]);
  } else if (scope === "episode") {
    const requestedKind = String(entry.kind || "").trim();
    if (!["episode reference", "character", "environment", "object"].includes(requestedKind)) {
      throw httpError(`DeepSeek new episode reference ${index + 1} kind must be episode reference, character, environment, or object.`, 502);
    }
    kind = "episode reference";
    base = join(target.episodeDirectory, "reference-images");
  } else {
    throw httpError(`DeepSeek new reference ${index + 1} scope must be story or episode.`, 502);
  }

  const promptPath = join(base, "prompts", `${slug}.prompt`);
  const generationDirectory = scope === "episode" ? join(base, "generated") : join(base, "images");
  const generationPath = join(generationDirectory, `${slug}.png`);
  return {
    id: `${scope}:${kind}:${slug}`,
    slug,
    name: slug.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
    kind,
    scope,
    prompt_path: relativePath(promptPath),
    prompt_text: promptText,
    generation_path: relativePath(generationPath),
    upload_path: relativePath(generationPath),
    images: [],
    ready: false,
    upload_ready: false,
  };
}

export function createAgentClipBatch(payload, generatedContent, commit = true) {
  const target = resolveCatalogEpisode(payload);
  const requestedMaximum = Number(payload.max_clips || 6);
  const maximumClips = Number.isInteger(requestedMaximum) && requestedMaximum >= 1 && requestedMaximum <= 8 ? requestedMaximum : 6;
  const parsed = parseAgentJsonObject(generatedContent);
  if (!Array.isArray(parsed.clips) || !parsed.clips.length) throw httpError("DeepSeek returned no clips.", 502);
  if (parsed.clips.length > maximumClips) throw httpError(`DeepSeek returned more than the requested ${maximumClips} clips.`, 502);
  const proposedEntries = parsed.new_references === undefined ? [] : parsed.new_references;
  if (!Array.isArray(proposedEntries)) throw httpError("DeepSeek new_references must be an array.", 502);
  if (proposedEntries.length > 12) throw httpError("DeepSeek returned more than 12 new references.", 502);

  const records = structuredRecords(target.episodeDirectory);
  const numericIds = records.map((record) => Number(String(record.payload.clip_id).match(/\d+/)?.[0])).filter(Number.isFinite);
  const firstNumericId = Math.max(0, ...numericIds) + 1;
  const episodeRelative = relative(target.storyDirectory, target.episodeDirectory).split(sep).join("/");
  const availableReferences = [...(target.story.references || []), ...(target.episode.references || [])];
  const referenceById = new Map(availableReferences.map((reference) => [reference.id, reference]));
  const proposedById = new Map();
  const referencesToCreate = [];
  for (const [index, entry] of proposedEntries.entries()) {
    const proposed = proposedReferenceRecord(target, entry, index);
    const duplicateProposal = proposedById.get(proposed.id);
    if (duplicateProposal) {
      if (duplicateProposal.prompt_text.trim() !== proposed.prompt_text.trim()) {
        throw httpError(`DeepSeek proposed conflicting prompt text for reference_id: ${proposed.id}`, 502);
      }
      continue;
    }
    proposedById.set(proposed.id, proposed);
    const existing = referenceById.get(proposed.id);
    if (existing) {
      if (String(existing.prompt_text || "").trim() !== proposed.prompt_text.trim()) {
        throw httpError(`DeepSeek proposed reference_id ${proposed.id}, but that reference already exists with different prompt text.`, 502);
      }
      continue;
    }
    if (isFile(safeRepositoryPath(proposed.prompt_path))) {
      throw httpError(`Reference prompt already exists outside the current catalog: ${proposed.prompt_path}`, 409);
    }
    referenceById.set(proposed.id, proposed);
    referencesToCreate.push(proposed);
  }
  const referencesToCreateIds = new Set(referencesToCreate.map((reference) => reference.id));
  const planned = [];
  const usedProposedReferenceIds = new Set();

  for (const [index, entry] of parsed.clips.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw httpError(`DeepSeek clip ${index + 1} is invalid.`, 502);
    const clipId = `clip-${String(firstNumericId + index).padStart(2, "0")}`;
    const mode = String(entry.generation_mode || "ref2va").trim();
    if (!["ref2va", "i2va", "post"].includes(mode)) throw httpError(`DeepSeek clip ${index + 1} has an unsupported generation mode.`, 502);
    const duration = Number(entry.duration_seconds);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 15) {
      throw httpError(`DeepSeek clip ${index + 1} must be greater than 0 and no more than 15 seconds.`, 502);
    }
    const title = String(entry.title || "").trim();
    if (!title) throw httpError(`DeepSeek clip ${index + 1} is missing a title.`, 502);
    const referenceIds = Array.isArray(entry.reference_ids) ? [...new Set(entry.reference_ids.map((value) => String(value)))] : [];
    const selectedReferences = referenceIds.map((id) => {
      let reference = referenceById.get(id);
      if (!reference) {
        const aliasMatch = id.match(/^(story|episode):[^:]+:([a-z0-9]+(?:-[a-z0-9]+)*)$/);
        if (aliasMatch) {
          const matches = [...proposedById.values()].filter((candidate) => candidate.scope === aliasMatch[1] && candidate.slug === aliasMatch[2]);
          if (matches.length === 1) reference = referenceById.get(matches[0].id) || matches[0];
        }
      }
      if (!reference) throw httpError(`DeepSeek clip ${index + 1} selected unknown reference_id: ${id}`, 502);
      if (referencesToCreateIds.has(reference.id)) usedProposedReferenceIds.add(reference.id);
      return reference;
    });
    const usePreviousFrame = entry.use_previous_frame === true;
    const previousClipId = index > 0 ? `clip-${String(firstNumericId + index - 1).padStart(2, "0")}` : records.at(-1)?.payload.clip_id || null;
    if (usePreviousFrame && !previousClipId) throw httpError(`DeepSeek clip ${index + 1} requested a previous frame but no preceding structured clip exists.`, 502);
    const pictureCount = (usePreviousFrame ? 1 : 0) + selectedReferences.length;
    if (pictureCount > 9) throw httpError(`DeepSeek clip ${index + 1} exceeds MiniMax H3's 9-picture limit.`, 502);
    if (mode === "i2va" && pictureCount !== 1) throw httpError(`DeepSeek I2VA clip ${index + 1} must have exactly one first-frame picture.`, 502);
    if (mode !== "post" && pictureCount < 1) throw httpError(`DeepSeek clip ${index + 1} requires at least one available reference image or previous-frame dependency.`, 502);

    const references = [];
    let nextPicture = 1;
    if (usePreviousFrame) {
      references.push({
        picture: mode === "post" ? null : nextPicture++,
        id: "previous-clip-last-frame",
        role: "first_frame_anchor",
        description: `Final frame from ${previousClipId} for visual continuity`,
        source: { type: "clip_artifact", clip_id: previousClipId, artifact: "last_frame" },
      });
    }
    const usedReferenceSlugs = new Set(references.map((reference) => reference.id));
    for (const [referenceIndex, reference] of selectedReferences.entries()) {
      let id = normalizedReferenceSlug(reference.slug, `reference-${referenceIndex + 1}`);
      let suffix = 2;
      while (usedReferenceSlugs.has(id)) id = `${normalizedReferenceSlug(reference.slug, "reference").slice(0, 64)}-${suffix++}`;
      usedReferenceSlugs.add(id);
      const imagePath = relative(target.storyDirectory, safeRepositoryPath(reference.generation_path)).split(sep).join("/");
      const promptPath = relative(target.storyDirectory, safeRepositoryPath(reference.prompt_path)).split(sep).join("/");
      references.push({
        picture: mode === "post" ? null : nextPicture++,
        id,
        role: reference.kind || "visual_reference",
        description: generatedReferenceDescription(reference),
        source: { type: "file", path: imagePath, prompt_path: promptPath },
      });
    }

    const continuityRequired = mode !== "post" && (mode === "i2va" || usePreviousFrame);
    const videoPrompt = mode === "post"
      ? null
      : withH3FirstFrameContinuity(String(entry.video_prompt || "").trim(), continuityRequired);
    if (mode !== "post") assertH3PromptFormat(videoPrompt, mode, continuityRequired);
    const clipPayload = {
      $schema: "../../AITurboShow/schemas/clip.schema.json",
      schema_version: 1,
      clip_id: clipId,
      sequence: records.length + index + 1,
      title,
      path_base: "story",
      generation_mode: mode,
      duration_seconds: duration,
      video_prompt: videoPrompt,
      first_frame_image_prompt: String(entry.first_frame_image_prompt || "").trim() || null,
      post_production_instructions: String(entry.post_production_instructions || "").trim() || null,
      references,
      outputs: {
        video: { path: `${episodeRelative}/generated/clips/${clipId}.mp4`, artifact_id: `${clipId}:video` },
        last_frame: { path: `${episodeRelative}/generated/frames/${clipId}-last.png`, artifact_id: `${clipId}:last_frame` },
      },
    };
    planned.push({
      path: join(target.episodeDirectory, `${clipId}.json`),
      payload: validateStructuredClipPayload(clipPayload, null, target.storyDirectory, target.episodeDirectory),
    });
  }

  const unusedProposals = referencesToCreate.filter((reference) => !usedProposedReferenceIds.has(reference.id));
  if (unusedProposals.length) {
    throw httpError(`DeepSeek proposed unused references: ${unusedProposals.map((reference) => reference.id).join(", ")}`, 502);
  }

  if (commit) {
    for (const reference of referencesToCreate) {
      const promptPath = safeRepositoryPath(reference.prompt_path);
      if (isFile(promptPath)) throw httpError(`A reference prompt already uses ${reference.id}.`, 409);
    }
    referencesToCreate.forEach((reference) => writeTextAtomically(safeRepositoryPath(reference.prompt_path), `${reference.prompt_text}\n`));
    planned.forEach((record) => writeJsonAtomically(record.path, record.payload));
  }
  return {
    story_id: target.story.id,
    episode_id: target.episode.id,
    created_count: commit ? planned.length : 0,
    preview_count: planned.length,
    created_reference_count: commit ? referencesToCreate.length : 0,
    preview_reference_count: referencesToCreate.length,
    references: referencesToCreate.map((reference) => ({
      reference_id: reference.id,
      scope: reference.scope,
      kind: reference.kind,
      prompt_path: reference.prompt_path,
      generation_path: reference.generation_path,
    })),
    clips: planned.map((record) => ({
      clip_id: record.payload.clip_id,
      sequence: record.payload.sequence,
      title: record.payload.title,
      duration_seconds: record.payload.duration_seconds,
      generation_mode: record.payload.generation_mode,
      reference_count: record.payload.references.length,
    })),
  };
}
