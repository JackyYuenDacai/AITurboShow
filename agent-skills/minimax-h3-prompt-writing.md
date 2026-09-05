# MiniMax H3 Prompt-Writing Skill

Apply this skill whenever writing `video_prompt` for MiniMax H3. Follow the requested generation mode exactly. Write structural field names and prompt descriptions in English, while preserving dialogue, lyrics, and visible text in their original language.

## Shared rules

- One generated H3 clip must never exceed 15 seconds. About 10 seconds is the preferred duration. Split longer beats, dialogue, and actions into sequential clips.
- Describe the target in playback order. Establish composition, subject identity and position, environment, lighting, actions and state changes, camera movement, synchronized sound, and the exact point where each reference takes effect.
- `[Shot 1]` has no timestamp. Later shots use strictly increasing cut times such as `[Shot 2] At 00:03.500, ...`, all within the clip duration.
- Write camera movement naturally as motion type plus meaningful amplitude and speed, for example: `The camera pushes in with small amplitude at slow speed.`
- Assign stable speaker IDs `(S1)`, `(S2)`, and so on. Put spoken words only inside `<d>[Language] ...</d>`. Preserve the original words and language.
- `overall_soundscape` contains ambience, physical sounds, and non-verbal human sounds. `non_diegetic_music` contains only audience-only background music; use `N/A` when absent.
- Use every and only the declared literal `<Picture N>` labels. Never invent, omit, renumber, or reuse a label with a different meaning.
- Return only the final prompt. Never add a preface, commentary, Markdown fence, `six-section structure:`, or bracketed substitutes such as `[subject_definitions]`.

## First-frame continuity rule

When `<Picture 1>` is the preceding clip's last frame, a `first_frame_anchor`, or the sole first-frame input of I2VA, the final prompt must begin with this exact line, character for character:

`For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.`

Put exactly one blank line after it. In `[Shot 1]`, begin from the identity, pose, composition, camera angle, lighting, object state, and spatial relationships in `<Picture 1>`, then develop forward continuously. Do not merely mention the picture; make it the actual frame at 0.00 seconds.

This continuity header is also mandatory for AITurboShow Ref2VA clips when `<Picture 1>` is the previous clip's last frame. After the blank line, continue with the six Ref2VA fields below.

## Ref2VA format

Use exactly these six fields in this order:

```text
subject_definitions:
...

summary:
...

retention_analysis:
...

detailed_description:
...

overall_soundscape:
...

non_diegetic_music:
...
```

- `subject_definitions` defines stable `<Subject N>`, `<Picture N>`, `<Video N>`, and `<Audio N>` meanings. A standalone picture label is appropriate when the image is a concrete first frame, keyframe, last frame, or composition anchor.
- `summary` begins with an accurate task prefix such as `[reference generation]` or `[keyframe completion + reference generation]` and introduces no new labels.
- `retention_analysis` gives one line per reference label. Visible-reference markers are `fully_preserved`, `partially_preserved`, `attribute_transfer`, or `weak_reference`. Audio markers are `fully_copy`, `partially_copy`, `reference`, or `weak_reference`.
- `detailed_description` is the explicit shot-by-shot audiovisual timeline. Cite every `<Picture N>` again exactly where it takes effect. For first-frame continuity, `[Shot 1]` must explicitly begin from `<Picture 1>` and preserve its visible state before motion begins.
- Keep every label's meaning consistent across all six fields.

## I2VA format

When `<Picture 1>` exists, begin with the exact first-frame continuity line above, then one blank line. Use exactly these fields in order:

```text
integrated_multimodal_description:
[Shot 1] ...

overall_soundscape:
...

non_diegetic_music:
...
```

`<Picture 1>` is the actual first frame. Preserve its style, identity, wardrobe, composition, objects, lighting, and spatial layout before describing the action onset and continuous development.

## Other base modes

- T2VA uses `integrated_multimodal_description`, `overall_soundscape`, and `non_diegetic_music` without an image-alignment instruction.
- FL2VA aligns Picture 1 to 0.00 seconds and Picture 2 to the exact ending time, then describes a continuous observable path between them.
- L2VA aligns Picture 1 to the exact ending time and describes a plausible path that converges to it.
