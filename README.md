# AITurboShow

AITurboShow is a local story production editor and ComfyUI control surface for this repository. It can create and edit stories, episodes, structured clips, and image-reference prompts while keeping generated assets inside declared repository destinations.

It scans the repository when the page loads and presents:

- Top-level story projects.
- Story-wide character, environment, and object references.
- Episode layers.
- Connected clip nodes.
- Clip durations and generation modes.
- H3 Prompt contents.
- Declared `<Picture N>` references.
- Existing image previews.
- Drag-and-drop generated image placement for declared reference destinations.
- Missing-reference and missing-duration status.
- Story and episode creation and full-outline editing.
- Clip creation, insertion, reordering, duration editing, Prompt editing, reference wiring, and output-path editing.
- Story-wide and episode-specific reference creation and Prompt editing.

## Run

From PowerShell:

```powershell
cd F:\GitHub\MiniMaxH3-TestBench\AITurboShow
node server.mjs
```

Or:

```powershell
.\start.ps1
```

Open:

```text
http://127.0.0.1:8765
```

## Production editor

The browser UI is a production editor, not only a viewer:

1. Use **+ Story** to create a story folder, outline, and standard character, environment, and object reference directories.
2. Select a story and use **Edit story** to edit its complete Markdown outline.
3. Use **+ Episode** to create the next numbered episode, or **Edit episode** to edit its complete Markdown outline.
4. Select an episode and use **+ Clip** to insert a structured clip at the start, end, before a selected clip, or after a selected clip.
5. Select a clip and use **Edit clip** to change its title, duration, generation mode, Prompt, first-frame Prompt, post-production instructions, reference JSON, or declared output JSON.
6. Use **Earlier**, **Later**, **Move to start**, or **Move to end** to change clip order.
7. Use **+ Reference** to create a story-wide character, environment, or object reference, or an episode-specific reference. Select the reference and use **Edit reference** to revise its Z-Image Turbo Prompt.

Clip IDs are stable. For example, inserting a new `clip-13` before `clip-03` changes sequence numbers but does not rename `clip-03` or break dependencies that identify it by ID. MiniMax H3 has a hard maximum of 15 seconds per clip and a preferred sweet spot of about 10 seconds. The DeepSeek agent is instructed to split longer beats into sequential clips, normally targeting 10 seconds each.

Content changes use atomic writes. The server writes a temporary file, preserves a backup while replacing an existing file, and rejects paths outside the intended story or episode.

## DeepSeek production agent

AITurboShow includes a server-side DeepSeek writing agent. The browser never receives the saved API key. Generated drafts are inserted into the active editor field so you can review and revise them before saving any production file.

## Standalone generation labs

The top navigation includes separate **Image lab** and **Video lab** pages for quick experiments outside a story project. Image lab drafts use the Z-Image Turbo reference-image prompt format. Video lab supports Text 2 Video (T2VA), I2VA, and full-reference Ref2VA prompt structures. Both pages can rewrite prompts through the configured DeepSeek agent and queue the result directly to ComfyUI; video durations are capped at 15 seconds and image/video dimensions and sampling steps are adjustable.

The labs share the Studio palette, panel layout, and status controls, with a stacked layout on smaller screens. Prompt text, extra direction, reference selections, and generation settings are saved locally in your browser. **Undo rewrite** restores the previous prompt; the editable **Prompt draft** panel supports copying and applying a revised draft.

Choose a resolution preset or enter custom dimensions (256–2048 pixels, in multiples of 16 for images or 32 for video). Leave Seed empty for a random seed, or enter a fixed seed, including zero. **Saved runs** includes previews, downloads, errors, and **Reuse settings**; new runs retain their seed, sampling steps, video mode, and reference order. Older runs may lack some settings. **Tasks** shows runs from both labs, and status refreshes automatically while the page is visible. Press **R** or **Refresh** to refresh manually.

For video references, add an existing repository-relative image path. Select exactly one image for I2VA or 1–9 images for Ref2VA; T2VA sends no reference images. Selected images are numbered in displayed library order and uploaded to ComfyUI before queueing. The prompt's `<Picture N>` tags must match those selections; rewrite the prompt after changing references. Last frames are saved under `AITurboShow/lab/`.

Lab regression checks use isolated storage and mocked generation responses; they do not queue renders or call DeepSeek:

```powershell
node --test AITurboShow/lab-api.test.mjs
# With Playwright and Chrome available, and AITurboShow running:
$env:LAB_TEST_URL = "http://127.0.0.1:8765"
node --test AITurboShow/lab-ui.test.cjs
```

Configure it from the **DeepSeek** button in the top bar:

1. Enter the DeepSeek API key.
2. Keep `https://api.deepseek.com` as the base URL unless you use a compatible HTTPS endpoint.
3. Keep `deepseek-chat` as the model, or enter another DeepSeek-compatible model.
4. Press **Save & test connection**.

Agent progress, success, and API errors are displayed persistently inside the open editor. If DeepSeek reports **Insufficient Balance**, add API credits to the DeepSeek account associated with the configured key and retry.

The key is stored in the ignored local file `AITurboShow/config.local.json`. A safe template is provided at `AITurboShow/config.local.example.json`. You can instead set these environment variables before starting AITurboShow:

```powershell
$env:DEEPSEEK_API_KEY = "your-api-key"
$env:DEEPSEEK_MODEL = "deepseek-chat"
$env:DEEPSEEK_BASE_URL = "https://api.deepseek.com"
.\start.ps1
```

DeepSeek drafting is available inside these editors:

- New story: story summary.
- Existing story: story summary and complete Markdown story outline.
- New episode: episode summary.
- Existing episode: episode summary, complete Markdown episode outline, and clip plan.
- Episode-level **Batch images**: choose multiple story or episode references and queue their Z-Image Turbo renders together.
- Reference previews open in a large in-app lightbox for full-size inspection without leaving the editor.
- New or existing clip: MiniMax H3 video Prompt.
- Existing clip: first-frame image Prompt and post-production instructions.
- New or existing reference: Z-Image Turbo reference-image Prompt.
- Episode-level **AI Clips**: automatically create the next batch of structured clips from the episode outline and existing production context.

Editor drafting replaces only the target field's current browser value; it never saves the project automatically. The previous field value is retained for **Undo draft** while the editor remains open. Press the editor's Save button to commit the replacement, use **Undo draft** to restore the pre-draft text, or close the editor to discard the unsaved draft.

The manual **+ Clip** editor includes a visual picker for story and episode reference images. It assigns ordered `<Picture N>` sockets, can reserve `<Picture 1>` for the actual preceding clip's last frame at the chosen insertion position, and shows whether the current prompt tags match those selected sockets before Save. I2VA requires exactly one image input; Ref2VA requires at least one selected reference or preceding last frame; all H3 modes keep the nine-image maximum. Prompt-only references may be attached while planning, but their PNG must be generated or uploaded before the clip can run. If the video prompt is blank, AITurboShow creates a structurally valid socket-matched placeholder. DeepSeek receives these unsaved selections when drafting the new clip and does not inherit an unrelated currently selected clip.

Use **Rewrite prompts** at episode level to choose a final target clip and optionally expand its complete previous-frame dependency chain. For example, selecting `clip-08` can expand from the earliest declared dependency through `clip-08`; that may be `clip-01 → ... → clip-08`, but a clip that starts a new visual chain stops the expansion there. DeepSeek rewrites and validates each expanded H3 prompt independently, then AITurboShow combines them in one review editor. No prompt file changes until **Save prompt replacements** is pressed.

Use **Regenerate chain** to force-regenerate the same dependency chain through MiniMax H3. AITurboShow previews the expanded order, asks for confirmation, and queues the earliest dependency first even when its old output already exists. This ensures every later clip receives the newly generated last frame from its newly generated predecessor.

Select an episode and press **AI Clips** to create up to eight clips per batch. DeepSeek skips story material already covered by existing clips, prefers 10-second clips, enforces the 15-second maximum, reuses equivalent story or episode references, optionally chains the previous clip's last frame, creates complete H3 Prompts, assigns stable unused clip IDs, validates every picture socket and output path, and then appends the batch. Run it again to continue a longer episode.

If a DeepSeek batch draft has a structural error—for example, it returns an undeclared reference ID or its selected reference sockets do not match the literal `<Picture N>` tags in an H3 Prompt—AITurboShow sends the exact deterministic validation error back to the agent and can request up to two corrected full batches before showing an error. Unknown references must be replaced by an existing exact ID or declared in `new_references` with a complete Z-Image Turbo prompt. The API response reports `agent_attempts`, `validation_recovered`, and `validation_recovery_count`.

If a required character, environment, object, or episode-specific visual does not have an equivalent reference, DeepSeek can propose it automatically and attach it to the appropriate clips. Reusable character, environment, and object prompts are saved in the story reference libraries; episode-only visuals are saved in the current episode reference library. These are created as **Prompt only** records—their images are not queued automatically. Select a new reference in AITurboShow and use its Z-Image Turbo action to generate the declared PNG before generating a dependent H3 clip.

For clips, the agent reads duration, generation mode, current reference-socket JSON, story and episode context, nearby clips, and unsaved form changes. DeepSeek receives the repository-owned MiniMax H3 prompt-writing skill in `agent-skills/minimax-h3-prompt-writing.md` on every clip-prompt and automatic clip-batch request. Ref2VA drafts use the exact colon-terminated fields `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, and `non_diegetic_music`; bracketed headings and `six-section structure:` prefaces are rejected. I2VA drafts use the required alignment instruction when `<Picture 1>` exists, followed by `integrated_multimodal_description`, `overall_soundscape`, and `non_diegetic_music`. It is instructed never to invent picture sockets that are not declared in the clip.

For previous-frame continuity, both I2VA and Ref2VA prompts are required to begin exactly with `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.` followed by one blank line. Deterministic server validation rejects incorrect structures, automatic DeepSeek batches can retry them, and the ComfyUI submission path also injects the exact header for older continuity clips that predate this rule.

Agent endpoints:

```text
GET  /api/agent/config    inspect configuration without exposing the key
PUT  /api/agent/config    save the key, base URL, and model
POST /api/agent/test      test the saved DeepSeek connection
POST /api/agent/generate  generate a production draft
POST /api/agent/regenerate-prompts preview dependency-expanded replacement prompts
POST /api/agent/create-clips generate and create the next validated clip batch
PUT  /api/content/clip-prompts validate and save reviewed prompt replacements
```

Set `preview_only: true` on `/api/agent/create-clips` to run DeepSeek planning and full clip/reference validation without writing clip or reference-prompt files. The response reports `preview_count`, `preview_reference_count`, and the proposed reference paths.

Generate an episode summary directly from PowerShell:

```powershell
$body = @{
  action = "episode_summary"
  story_id = "futuristic-utopian"
  instruction = "Write in Chinese and emphasize the emotional turning point."
  fields = @{
    title = "A New Episode"
    summary = ""
  }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:8765/api/agent/generate `
  -ContentType application/json `
  -Body $body
```

Valid actions are `story_summary`, `story_outline`, `episode_summary`, `episode_outline`, `clip_prompt`, `first_frame_prompt`, `post_production_instructions`, and `reference_image_prompt`.

Use another port if needed:

```powershell
.\start.ps1 -Port 8877
```

Connect to a ComfyUI backend on another address:

```powershell
.\start.ps1 -ComfyUIUrl http://127.0.0.1:8188
```

### Local-only binding and API token

`start.ps1` binds to `127.0.0.1` by default, so the editor and its API are reachable only from this machine. To expose AITurboShow on your LAN, pass a host address and a shared token, for example:

```powershell
.\start.ps1 -HostAddress 0.0.0.0 -Token some-shared-secret
```

When a token is set, every `/api/*` request from a non-loopback client must carry it, either as an `Authorization: Bearer <token>` header or a `?token=<token>` query parameter. Loopback clients (the local browser) always work without a token. With no token set, the API is open, so keep the loopback-only binding. The token can also be provided with `--token` to `node server.mjs` or the `AITURBOSHOW_TOKEN` environment variable.

## MiniMax H3 backend

AITurboShow can validate and queue structured I2VA and Ref2VA clips directly through a local ComfyUI backend. ComfyUI remains the inference service; its browser interface does not need to be open. The **Tasks** button opens a live generation panel showing waiting, preparing, ComfyUI-queued, running, finalizing, completed, skipped, and error stages with queue positions and progress indicators.

Reference cards can also generate their declared images directly with the repository's `workflow/image_z_image_turbo.json` setup. Select a story or episode reference, choose the output size, validate the backend, and press **Generate image**. The completed PNG is copied into the reference's canonical `images/<slug>.png` or `generated/<slug>.png` destination and becomes available to dependent H3 clips after the catalog refreshes.

Before starting AITurboShow:

1. Start ComfyUI on `http://127.0.0.1:8188`.
2. Install `comfyui-custom-nodes/ComfyUI-Roroky-H3-Batch` under the ComfyUI `custom_nodes` directory.
3. Install the MiniMax H3 video VAE, audio VAE, Ref2VA diffusion model, and Qwen3-VL text encoder listed in `workflow/video_minimax_h3_r2v.json`.
4. Start AITurboShow and select a structured clip.
5. Use **Validate**, then **Queue H3** in the clip inspector. To queue several clips, press the episode-level **Queue H3** button, select any combination of clips, or choose **Whole episode**.

AITurboShow stages declared references through the custom-node backend, submits a normal ComfyUI API prompt, polls its history, finalizes the generated MP4 and last frame into the clip's declared `outputs` paths, and refreshes the catalog after completion. Select a completed clip to preview its generated video directly in the inspector; the muted preview starts automatically and loops continuously, with normal playback controls available for sound, seeking, and pausing.

The episode page also includes a whole-episode preview. It plays available generated clips in sequence, advances automatically at each clip boundary, and wraps back to the first available clip for continuous playback. Clips that have not generated an output yet are skipped and counted in the preview footer.

Backend endpoints:

```text
GET  /api/comfy/status
GET  /api/comfy/jobs
POST /api/comfy/validate
POST /api/comfy/generate
POST /api/comfy/generate-batch
POST /api/comfy/jobs/cancel
POST /api/comfy/image/validate
POST /api/comfy/image/generate
```

H3 generation defaults to 864x480 (about 0.4 MP), 24 fps, 20 `res_multistep` sampling steps, the `simple` scheduler, `match` reference sizing, and a randomized seed. Both the single-clip inspector and episode queue provide presets from 0.2 MP through 0.98 MP. The generation endpoint accepts an optional `options` object containing `width`, `height`, `steps`, `scheduler`, `ref_image_size`, and `seed`.

Batch jobs first enter AITurboShow's in-memory waiting queue and are submitted to ComfyUI one H3 clip at a time. This preserves playback order and lets a previous clip's finalized last frame become available before a dependent later clip is prepared. A clip whose only missing input is an earlier clip's `last_frame` remains queueable: AITurboShow recursively stages the missing prerequisite clip or dependency chain first. Fixed missing character, environment, object, or episode-reference images still block queueing until generated or uploaded. Completed clips are skipped unless `force: true` is supplied. Use `whole_episode: true` for all eligible clips or pass `clip_ids: [...]` for a custom selection. Set `preview_only: true` to inspect the expanded queue plan, including automatically added prerequisites, without starting generation. A running prompt cannot change resolution in place; cancel it from the Tasks panel and queue it again with the desired preset.

Queue from PowerShell without opening either browser interface:

```powershell
$body = @{
  story_id = "futuristic-utopian"
  episode_id = "episode-01"
  clip_id = "clip-03"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:8765/api/comfy/generate `
  -ContentType application/json `
  -Body $body
```

Poll `GET /api/comfy/jobs` for `queued`, `running`, `finalizing`, `completed`, or `error` status. If all declared outputs already exist, explicitly include `force = $true` to regenerate them.

Z-Image Turbo uses `z_image_turbo_bf16.safetensors`, `qwen_3_4b.safetensors`, and `ae.safetensors`, with AuraFlow shift 3, CFG 1, `res_multistep`, the `simple` scheduler, and 15 steps. Its generation endpoint accepts the same optional `seed` convention plus `width`, `height`, and `steps` under `options`.

Generate a reference from PowerShell using the same `workflow/image_z_image_turbo.json` backend path as the UI:

```powershell
$body = @{
  story_id = "futuristic-utopian"
  episode_id = "episode-01" # Use $null for a story-wide reference.
  reference_id = "episode:episode reference:example-reference"
  options = @{
    width = 1344
    height = 768
    steps = 15
  }
} | ConvertTo-Json -Depth 4

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:8765/api/comfy/image/generate `
  -ContentType application/json `
  -Body $body
```

Use the `reference_id` returned by `GET /api/catalog`. Validate first with `/api/comfy/image/validate` if desired. When generation completes, AITurboShow copies the PNG to the reference's canonical destination and refreshes its preview.

## Content API

The production editor uses these local endpoints:

```text
POST /api/content/story       create a story
PUT  /api/content/story       replace a story outline
POST /api/content/episode     create the next numbered episode
PUT  /api/content/episode     replace an episode outline
POST /api/content/clip        create and insert a structured clip
PUT  /api/content/clip        update a complete structured clip payload
POST /api/content/clip/move   reorder a structured clip
POST /api/content/reference   create a story or episode reference Prompt
PUT  /api/content/reference   update a reference Prompt
```

Example: add a clip after an existing clip:

```powershell
$body = @{
  story_id = "futuristic-utopian"
  episode_id = "episode-01"
  title = "New connecting shot"
  duration_seconds = 8
  generation_mode = "ref2va"
  position = "after"
  anchor_clip_id = "clip-03"
  video_prompt = "integrated_multimodal_description: ..."
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:8765/api/content/clip `
  -ContentType application/json `
  -Body $body
```

Valid clip positions are `start`, `end`, `before`, and `after`. Valid move directions are `earlier`, `later`, `start`, and `end`.

## Discovery rules

A top-level directory is treated as a story when it contains one of:

- `outline.md`
- An `episode-XX` directory
- `sceneN.prompt` files

Story references are discovered under:

```text
characters/prompts
characters/images or characters/generated
environments/prompts
environments/images or environments/generated
objects/prompts
objects/images or objects/generated
```

Episode clip nodes are discovered from `clip-XX-*` files. A structured `clip-XX.json` file is authoritative when present. It contains the duration, generation mode, complete video Prompt, optional first-frame image Prompt, ordered references, previous-clip artifact dependencies, and declared outputs.

The **Episode reference library** also discovers image-valued `source.type: "file"` inputs declared by those clips, including paths outside the standard reference folders and images that have not been generated yet. Discovery respects each clip's `path_base`, deduplicates matching image paths against the existing libraries, and shows **From clips** cards with their usages. Select a card to inspect its destination, add or edit an image prompt, or jump to a clip that uses it. Discovered references are available in the manual clip picker and the production agent's reference context.

Discovery itself does not modify clip JSON or create index files. Existing declared prompt paths are used when available; a clip's inline first-frame image prompt is also available for its declared first-frame anchor. When no prompt path is declared, **Add reference prompt** saves a stable prompt under the episode's `reference-images/prompts` directory while keeping the clip's original image destination. Previous-frame `clip_artifact` references remain graph dependencies. Free-text mentions without a declared file source are not guessed into image paths.

Run discovery regressions with `node --test AITurboShow/episode-references.test.mjs`.

The scanner reads clip information in this order:

1. `clip-XX.json`.
2. The episode outline and duration wording inside a legacy `.prompt` file when no structured clip record exists.

Legacy `.prompt` files remain visible as a read-only fallback, but AITurboShow does not guess their reference mappings. New automation should read the per-clip JSON files.

## Structured clip format

All paths inside a structured clip are relative to the story directory when `path_base` is `story`.

```json
{
  "$schema": "../../AITurboShow/schemas/clip.schema.json",
  "schema_version": 1,
  "clip_id": "clip-07",
  "sequence": 7,
  "title": "Example clip",
  "path_base": "story",
  "generation_mode": "ref2va",
  "duration_seconds": 12,
  "video_prompt": "subject_definitions:\n...",
  "first_frame_image_prompt": null,
  "post_production_instructions": null,
  "references": [
    {
      "picture": 1,
      "id": "previous-clip-last-frame",
      "role": "first_frame_anchor",
      "description": "Final frame from the preceding clip",
      "source": {
        "type": "clip_artifact",
        "clip_id": "clip-06",
        "artifact": "last_frame"
      }
    }
  ],
  "outputs": {
    "video": {
      "path": "episodes/current/generated/clips/clip-07.mp4",
      "artifact_id": "clip-07:video"
    },
    "last_frame": {
      "path": "episodes/current/generated/frames/clip-07-last.png",
      "artifact_id": "clip-07:last_frame"
    }
  }
}
```

Do not replace a previous-frame dependency with a guessed PNG path. `source.type: "clip_artifact"` identifies the producing clip and artifact. AITurboShow resolves that dependency through the producing clip's `outputs` declaration.

## Behavior

- Story, episode, structured clip, and reference Prompt changes are made only through the explicit production-editor endpoints.
- Drop a generated image onto a reference card or a clip's reference card to save it to that reference's declared destination.
- Dropped images are converted in the browser to the destination's declared PNG, JPEG, or WebP format.
- Existing destination images require confirmation before replacement.
- Uploads are limited to 50 MB and are accepted only for exact paths declared by `source.type: "file"` or image-valued `source.type: "clip_artifact"` references.
- Arbitrary repository paths cannot be uploaded through the image endpoint.
- Images are served only from inside the repository.
- Refresh the catalog with the top-right button or press `R`.
- Click a clip node to inspect its Prompt, references, and images.
- Click a shared reference card to inspect its image-generation Prompt and generated PNGs.
- Missing images appear as explicit placeholders rather than disappearing from the graph.

## Files

```text
AITurboShow/
├── server.mjs         filesystem scanner, editor API, and ComfyUI backend
├── schemas/           structured clip JSON Schema
├── validate-clips.mjs generic structured-clip validator
├── index.html         application shell
├── styles.css         visual design
├── app.js             graph, editor, and generation interactions
├── start.ps1          Windows launcher
└── README.md
```

Validate any episode directory without embedding project paths in the tool:

```powershell
node validate-clips.mjs ..\path-to-story\episode-directory
```
