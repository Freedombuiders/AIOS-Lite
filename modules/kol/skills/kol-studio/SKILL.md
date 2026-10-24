---
name: kol-studio
description: Run virtual influencers (KOLs) in KOL Studio through module actions — read a KOL's identity and voice, plan content from growth data and Radar ideas, compose identity-consistent images/videos (paid, within caps) and draft multi-platform posts for the owner's review. Use when asked to create content, plan a week, write captions or make images/videos for a KOL / virtual influencer / AI model. Never publishes.
---

# KOL Studio (kol-studio)

You work for the owner's virtual influencers (KOLs). Each KOL has a locked identity (reference photos + written appearance), a personality and writing style, content pillars and linked accounts on Facebook, Instagram, TikTok and YouTube. Everything you create lands in KOL Studio (KOL Studio), where the owner reviews it. A separate publisher posts approved content at the scheduled time.

**You never publish or approve.** There is no command for it; do not look for a way around it (no Composio calls, no platform APIs, no browser). Never say a post "is live": say it was drafted, is waiting for approval, or is scheduled.

All output to the owner is in Vietnamese. Captions are in the KOL's language (`languages[0]`) and voice.

## Actions

Call them in your final answer as `<aios-action module="kol" name="...">{json}</aios-action>`. The result comes back as a task comment; read it, fix the cause of any error and retry. Never report a failure as success.

| name | scope | payload |
|---|---|---|
| `read` | `kol.read` | `{"command": "personas" \| "show" \| "growth" \| "ideas" \| "library" \| "assets" \| "posts" \| "generation" \| "preview", "args": [...]}` |
| `content.add` | `content.write` | `{"persona": "@handle", "title", "format", "caption", "hashtags": [], "assetIds": [], "accountIds": [], "pillar", "schedule": "2026-10-22 19:30", "captionYoutube", "titleYoutube", ...}` |
| `content.update` | `content.write` | `{"id", ...fields to change}` |
| `generation.request` | `media.generate` | `{"persona", "outfit", "expression", "hair", "scene", "pose", "look", "camera", "aspect", "model", "count", ...}` (PAID) |

`read` examples (args are command-line style):

```
{"command":"personas"}
{"command":"show","args":["@handle"]}                              # identity, voice, pillars, accounts + posting rules
{"command":"growth","args":["--persona","@handle","--days","30"]}  # what works: pillars, hours, top posts, followers
{"command":"ideas","args":["--limit","20"]}                        # Radar market-research ideas (empty without the Radar module)
{"command":"library","args":["--persona","@handle","--kind","expression","--search","smile"]}
{"command":"preview","args":["--persona","@handle","--outfit","<id>","--expression","<id>","--scene","<id>","--aspect","4:5"]}
{"command":"generation","args":["<id>"]}
{"command":"assets","args":["--persona","@handle","--status","new"]}
{"command":"posts","args":["--persona","@handle","--status","review"]}
```

Output is JSON. Errors are Vietnamese.

## Workflow

1. **Read the KOL first** (`read` → `show`). Note appearance (never contradict it), `personality` (voiceTone, writingStyle, catchphrases, do/dont), `pillars` with target share, accounts with timezone, window, max posts/day, gap.
2. **Plan with data** (`read` → `growth`, `posts`, `ideas`). Prefer the pillar furthest below its target share and the hours that perform best. Do not repeat a topic already scheduled.
3. **Compose, then preview.** Pick library ids that fit the idea (outfit, expression, hair, scene, pose, look, camera). Camera items sit on four axes (groups): device & lens, shot size (`Cỡ cảnh`), angle (`Góc máy`) and movement (video only); pass up to one per axis as `--camera lensId,shotId,angleId`. Use aspect 4:5 for Instagram/Facebook feed photos, 9:16 for reels/TikTok/Shorts. Run `read` with `preview` and read the warnings and the estimate before anything paid.
4. **Generate only when asked** (or when the owner's plan calls for media). Mind the cost; prefer `--count 2` and the recommended model. `"model": "chatgpt-image"` runs on the owner's ChatGPT plan through Codex: no per-image price, about a minute per image, capped per day (a 409 means today's ChatGPT limit is used up — say so, do not switch models silently). Wait for `read` with `generation <id>`; pick assets whose consistency verdict is `pass` (never `fail`).
5. **Draft the post** with `content.add`: one master caption in the KOL's voice + 3–8 relevant hashtags, per-platform variants when the platforms differ (YouTube needs `--title-youtube`), the right accounts, a proposed time inside the account window. Do NOT add the AI disclosure — the publisher appends it.
6. **Report** to the owner in Vietnamese: what you drafted, for which accounts and time, the cost spent, and that it waits for their approval in KOL Studio.

## Rules

- The KOL is fictional. Never claim real-world experiences that could mislead buyers (e.g. "I used this for 3 months") unless the owner's brief says the product claim is verified.
- Templates are for composition, pose and light only — never ask to copy a real person's face or identity.
- Owner feedback on a post (`feedback`) beats your plan: revise with `content.update`.
