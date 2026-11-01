# PROCESS · How it was made, and how AI was used

Project: Stretch Miner · Help Granny Find Her Jewellery (SD5913 Assignment 3, interactive experience)
Online: https://ardenshi.github.io/stretch-miner/

## 1. Where the idea came from

The Assignment 3 brief: build a small interactive experience for someone, turning
"input → response → feedback" into a closed loop. I first picked a target user
(sedentary, wants to move a little, does not want to hold their arms up), then
wanted a mechanism where **the movement itself is the input** — which landed on a
**stretch version of the classic "gold miner" game**: shift your body (or head)
left or right of the camera frame and the hand keeps growing that way; hold the
lean and it keeps growing; come back to the centre and it snaps back instantly.

The theme later changed from "miner digging gold" to **a granny looking for her
jewellery on a messy desk**: the target user, the action and the feedback loop
stayed, but the world gained a story — her glasses, necklace, earrings, ring,
brooch and hairpin scattered on the desk, mixed with bugs and live plugs.

## 2. AI usage log (the honest version)

The code was pair-written with an AI assistant (WorkBuddy / Claude). Rough split:

**What I decided:**
- The core mechanic (gold miner + camera + continuous stretching instead of clicking)
- The target user and the hands-free control (body lean, not gesture recognition)
- The theme (granny looking for jewellery) and the hazards (bugs / bare live plugs)
- The art direction (visible strokes, high saturation)
- What to change after each round of playtesting (see section 3)

**What the AI implemented:**
- The MediaPipe Pose Landmarker integration (including vendoring it locally, with a local-first / CDN-fallback load chain)
- The arm state machine, collisions, sound effects, the frozen result frame
- The hand-drawn stroke rendering system (deterministic jitter outlines + offscreen static layer)
- The whole-window shake CSS animation and its reduced-motion fallback
- Deployment (GitHub Pages) and debugging tools (diagnostic line, sensitivity slider)

**Pits the AI fell into, and we watched them get fixed (so we don't forget):**
- Camera at 30 fps vs page at 60 fps meant the "same video frame" was misread as
  "the person let go" and the arm locked forever — one real cause of the first
  playtest's "reaching does nothing", and nothing to do with thresholds.
- The lean→angle mapping once had a 28° dead zone; anything straight above could
  never be reached and the game was unwinnable.
- Setting `<video>` to `display:none` makes some browsers stop decoding frames —
  hide it with the 2px trick instead.

## 3. Playtests, and the two rounds of changes they caused

Two friends tried it one after the other (3–5 minutes each; I only noted their
first reactions and confusions).

### Test 1: the failure feedback was too weak

**Observation:** the first tester touched a bug/plug and barely reacted — the
original feedback was just a red flash in the canvas and a small shake. He said
"That's it? I thought I didn't touch it", and only noticed a try was gone seconds
later. For him, **the weight of the punishment did not match the cost of the
action**: losing a try is the most important negative consequence of a round, yet
it happened almost invisibly.

**What changed:**
- **The whole browser window now shakes**: not just the canvas — `<body>` gets a
  `.quake` class running a 0.7 s CSS shake (automatically disabled when the system
  asks for reduced motion).
- The in-canvas shake got stronger (bigger amplitude + a slight rotation, slower
  decay) so being hit feels physical.
- Layered feedback: the flash colour identifies the hazard (bug → green,
  plug → electric blue), a hand-written quip pops on the canvas
  ("Ahh — a bug!", "Ouch! It's live!"), and the status line says plainly
  "That was a bug — lower your arm, then reach again".
- The sound changed from one low thud to a harsher downward slide.

**My takeaway:** the intensity of failure feedback should be proportional to how
bad the consequence is. This change added no new mechanic — it just amplified a
consequence that already existed until it could actually be felt.

### Test 2: the art was too plain for such a playful premise

**Observation:** the second tester said "the interface looks so crude" — the
original was a dark cave background + a few geometric shapes (diamonds, gold
nuggets, money bags). It looked like a tech demo, not a game about helping a
granny find her jewellery. His point was not the features but that **the visuals
did not carry the setting**: the rules sounded warm and funny, the screen looked
like cold geometry, and the charm did not land.

**What changed:**
- New theme: bombs → **bugs** (six wiggling legs) and **bare live plugs**
  (trailing a cord, throwing sparks); treasures → six pieces of hand-drawn jewellery.
- A **marker-pen stroke rendering toolkit**: each shape gets one fill pass + two
  deterministic jittered outlines, colour deliberately spilling past the lines;
  the jitter uses a fixed seed, so the same object jitters the same way every
  frame and nothing flickers.
- Background: warm orange wood + a spread of old newspaper + teacup, medicine
  bottles, yarn, letters, buttons — the static parts are painted once into an
  offscreen layer, so performance does not suffer.
- Granny: the camera feed sits in a golden frame as her face, with white hair
  curls and a knitted shawl on both sides; what reaches out is a freckled arm
  with five fingers (they close when she grabs something).
- Palette switched from dark cave to high-saturation wood orange + magenta + teal.

**My takeaway:** the art style is not decoration — it is the direct evidence of
whose world this is. The tester's feedback made "game feel" an acceptance
criterion as important as the interaction itself.

## 4. Where it stands, and what is next

- Both rounds of changes are live (2026-11-01).
- Next: have the same two testers play the new version and confirm the shake
  intensity and the art direction; keep calibrating the head-mode thresholds on
  more people with the "sensitivity" slider instead of editing code.
