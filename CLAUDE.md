# CLAUDE.md

Standing policy for this repository. Read it before making any change here.

## What this repo is

A Cloudflare Workers static-assets site. Everything served lives in `public/`
and there is no build step - the files in that directory are the site. The repo
is connected to Cloudflare Workers Builds, so **every push to `main` deploys to
production**.
Production is served at https://datacentreforge.cloudflare-passport599.workers.dev/.

```
public/            everything served
  index.html
  404.html
  favicon.svg
  robots.txt
  _headers         security + caching headers
  assets/css|js
  examples/        the example Revit export placed by the Example button
prompt text/       provenance for the version in service, replaced each release
tools/revit/       Revit-side exporter script (not served)
tools/ifc/         IFC reader that builds the MV example (not served)
.claude/skills/    the prompt-archive skill: how the provenance archive is kept
wrangler.jsonc     assets-only config, no Worker script
package.json       wrangler devDependency + dev/deploy scripts
```

## Local development

```bash
npm install
npm run dev          # wrangler dev
```

## Verification - before every push to main

1. `npx wrangler deploy --dry-run`
2. Serve `public/`, render it with headless Chromium, and inspect the
   screenshots: styles applied, fonts loaded, layout intact.

Never leave pushed work unverified or half-finished. Work in small, complete
batches: implement, verify, commit, push.

Known screenshot artifact: headless Chromium clamps its window to a minimum
width of about 500px, so "mobile"-width captures are a 500px layout cropped at
the right edge. Content cut off at the right of a narrow screenshot is the
capture tool, not the page — re-shoot at 500px wide before treating it as a
layout bug. Real phone viewports honour the meta viewport tag and are fine.

## Git and release workflow

- Before committing: `git config user.name "Fid" && git config user.email "fid_kk@proton.me"`
- Develop on the working branch and push there first. Release verified work by
  fast-forwarding `main` onto it and pushing `main`.
- Every push to `main` is a release. Versions are an ascending `vMAJOR.MINOR`
  sequence starting at `v1.0`; every push bumps the minor regardless of size. A
  major bump is reserved for a ground-up overhaul.
- With every push to `main`, provide release-tag text in the reply, in exactly
  this shape. The owner creates the GitHub release manually - **never push tags**:

  ```
  Tag: v<next>  —  Title: <five to nine words, plain and evocative>
  Description: <one to three sentences of editorial prose describing what changed
  from the owner's point of view — outcomes, not implementation. No bullet lists,
  no jargon, no file names.>
  ```

- Append the release line to the ledger below as part of the same push.
- Commit messages: descriptive imperative first line (what the change does, not
  "update X"), then a short prose body; dash bullets are fine there. One commit
  per coherent piece of work; several may share a push, but each push gets
  exactly one version entry.
- Never include model names, AI attribution trailers, session links, or other
  tooling identifiers in commit messages, titles, or code. The `prompt text/`
  archive is the one deliberate exception: its files are owner-supplied records
  and say what the owner tells them to say.

## The page itself

Content, design, and behaviour are as supplied by the owner. Do not tidy markup,
rename classes, rewrite copy, or modernise CSS unless asked - changes to the
design are their own release, requested deliberately.

New versions of the page arrive from the owner as a single self-contained
`manhole-plan*.html` file. To release one: split its lone `<style>` block into
`public/assets/css/site.css` and its lone `<script>` block into
`public/assets/js/app.js` verbatim, reference them from `index.html` in the
same positions, and bump the `?v=` release stamp on the asset URLs in
`index.html` and `404.html`. Then verify, commit, and release as above.

## The provenance archive

`prompt text/` holds the records for the version of the page currently in
service — nothing else. Shipping version N replaces the folder's contents
wholesale, in the same push to main that releases the version:

- remove the previous version's folder(s)
- add `prompt text/N/` (N is the owner's version number) containing
  `input.txt` — the prompt that produced the version, byte-for-byte as
  supplied — `output.txt` — the reply that shipped it, byte-for-byte as
  supplied — `ai model.txt` — the model attribution: unless the owner directs
  otherwise for a version, it reads, on three lines, Anthropic / Claude /
  Fable 5 Max — and any input images the owner has provided

Do this with every push to main that ships a version. Older versions' records
are not lost: each remains in the tree of the release that shipped it. The
files themselves are owner-supplied records — never edit, reformat, trim, or
"fix" them, and never regenerate them from memory.

## Release ledger

| Version | Title | Description |
| --- | --- | --- |
| v1.0 | The manhole plan drawing board goes live | The site opens with an interactive plan-view drawing board: lay out numbered chambers, set internal size and wall thickness, and join their faces with measured connection lines. Pan, zoom, snap to grid, and save or load the drawing as a file. |
| v1.1 | Connections become real pipe runs with bends | Joining two chambers now draws an actual pipe run: it leaves one face square-on, arrives square-on at the other, and only turns through the fitting angles allowed. Each run reports its bends, straights and end-to-end length, and says when no route can be made. |
| v1.2 | Obstacles and a shared pipe spec library | Rectangular obstacles can be dropped onto the plan and runs steer around them at a safe distance. Pipes are driven by named, colour-coded specs shared across the drawing, and questionable geometry — an over-limit bend, a squeezed radius — is flagged on the run itself. |
| v1.3 | Smarter routing that respects the straights | The router now weighs options like a detailer: extra fittings must earn their place, minimum straights off the chamber and between bends are honoured, and full bend radii are kept wherever there is room. Dragging stays responsive while routes resolve. |
| v1.4 | Buffer zones keep everything at a distance | Chambers, obstacles and the runs themselves carry buffer zones, and new routes keep out of all of them — including pipes already placed. Two placed runs that end up closer than their buffers allow are both flagged. |
| v1.5 | Pipes become conduits with entries and levels | The tool now speaks electrical: runs are conduits with ready-made MV, LV, ELV, fibre and telecoms specs. Runs sharing a chamber face spread out at the chamber's own spacing without crossing at the wall, and each run can sit on its own level, passing cleanly over the ones below. |
| v1.6 | Runs travelling together share one road | Conduits joining the same two faces are now routed as a single bank — one centreline, many parallel lanes — so grouped runs read as one tidy road rather than a tangle of near-parallel paths. Routes also hold to the directions they leave and enter on, stepping aside only as far as needed. |
| v1.7 | The spec panel stops repeating itself | The conduit spec editor listed its buffer measurement twice; it now appears once. |
| v1.8 | Conduit arrays and a section through every face | A manhole now opens a cross-section of each connected face: every conduit drawn to scale on a shared grid, clearances marked, overcrowding flagged. Runs can be arrays of columns and rows, different services line up on the largest spacing present, and every leg between bends is guaranteed real straight duct or the route honestly refuses. |
| v1.9 | The archive travels light with each release | The prompt archive now carries only the version in service; each release swaps in its own records and clears the rest. Earlier conversations remain with the releases that shipped them. |
| v1.10 | Sides get names and their own settings | Chamber sides are now labelled A to D on the drawing and everywhere they are referred to. The per-side details left the panel: each side is a single button that opens its settings — runs, stacking and the cross-section — in a pop-up. |
| v1.11 | Runs stop detouring around nothing | A manhole sitting a whisker out of line used to force a full flight of bends even with a clear path. Anything within a couple of degrees of square now lays as one dead-straight duct, while real offsets and real obstacles still get their honest fittings. |
| v1.12 | The archive always names its maker | Every version's record now carries its model attribution as standard, filled in automatically unless directed otherwise. The records of the two newest versions were completed to match. |
| v1.13 | The panels fold away until needed | The properties that filled both side panels now sit behind tidy buttons — geometry, position, spacing, sizes, rules — each showing its key numbers at a glance and opening only when pressed. Warnings and the main actions stay in view, so the screen carries far less at once. |
| v1.14 | The site's address goes on record | The repository now states where the live site is served, so anyone reading it — or any future working session — knows the production address without asking. |
| v2.0 | Manholes arrive straight from Revit | The plan can now be built from a Revit project: each placed manhole comes in at its true position and rotation, with wall thickness, lid outline and conduit windows read from the family's named reference planes, and its sides carry the family's own plane names. A window from the family now governs how much each face can carry. |
| v2.1 | Runs go over, under or around obstacles | Obstacles now have a top and a bottom and say how a run may pass them: around, over or under. Going round is always preferred; when nothing gets round, the run crosses — under by default, over as the fallback — and each run gains a long section showing its vertical bends, the obstacles it crosses and its true laid length. Revit obstacles arrive with those rules read from their parameters. |
| v2.2 | The whole drawing turns to show its depths | A 3D view joins the plan: chambers and obstacles stand as boxes between their top and bottom levels, and every conduit run is drawn at its true depth, diving under an obstacle or riding over it exactly as routed. Drag to orbit, scroll to zoom, click to select, and switch back to the plan at any time. |
| v2.3 | A crossing always finds its way through | A run that has to cross an obstacle no longer gives up when its plan bends leave no room for tidy vertical ones: the section is now built directly, dipping under or humping over, taking whichever deviates less and flagging a compound bend where a vertical bend must land on a plan bend. The drawing gains a ground level and a minimum cover, so over never breaks the surface. |
| v2.4 | Revit elements keep their identity between exports | Every manhole and obstacle now remembers which Revit element it came from. Export the model again after changes and the drawing refreshes in place — moved manholes move, new ones appear, nothing already connected loses its runs. Those ids and the source document travel in the drawing's own export too. |
| v2.5 | Manholes say how their runs may pass things | The avoidance rules now live on the manholes, as the Revit family provides them: each chamber says whether its runs may go around, over or under whatever they meet, and a run obeys both of its chambers. When a dip cannot climb back in time, the run enters the chamber lower and says so, instead of refusing. |
| v2.6 | Runs slide along the face before they bend | Two chambers a little out of line no longer force a pair of bends: each run now meets its faces wherever it lines up with the far face, sliding within the conduit window or the face's clear width, and bends only for what that cannot absorb. Runs sharing a face keep their order and spacing around their own alignments. |
| v2.7 | Every run decides how it passes each obstacle | How a run passes an obstacle is now chosen in the drawing itself: each obstacle carries a default — around unless changed — and each run's panel lists the obstacles with an around, over or under choice for that run alone. The Revit obstacle parameters and the chamber-level rules are gone. |
| v2.8 | The side panels give way to a ribbon | Everything that filled the two side panels now lives behind a ribbon of buttons across the top — chambers, runs, obstacles, specs, drawing and file — each opening a window that can be dragged about, with as many open as you like, and the drawing takes the whole width. Select anything on the plan and the buttons that concern it light up. |
| v2.9 | Named groups, icons and a wheel of choices | The ribbon now reads like a proper toolbar — Create, View, Manage, Settings — with an icon on every button and the counts kept. Connecting faces is no longer a mode: right-click a face and a ring of choices opens around the cursor, Inventor-style, offering to connect from it; right-click a chamber, obstacle, run or empty space for its own ring. |
| v2.10 | Window selection, pinch zoom and the iPad joins in | Drag on empty space to select the Revit way: left to right takes what lies wholly inside, right to left takes whatever the box touches, and the whole set moves, nudges and deletes together. The middle or right button drags the view, a touchpad or two-finger pinch zooms, and an Example button places the three DCBuild manholes. On an iPad the same tool works by hand: one finger selects or draws the box, two fingers pan and zoom, and a held finger opens the ring, which now offers to delete everything selected. |
| v2.11 | Double-click to connect, and undo comes to the drawing | Double-click a face, then double-click a face on another chamber, and the run is made and placed on the spot with nothing to approve; a single click on the second face does the same, as does a double-tap on an iPad. Undo and redo arrive beside the title and on the usual keys, stepping through every change to the drawing while leaving the view where it is. |
| v2.12 | The stylesheet and script stamps catch up | Version 2.11 went out wearing the previous release's cache stamp, so a browser that had visited before could keep its old files and miss the new buttons. This release restamps them, so everyone gets the double-click connecting and the undo and redo. |
| v2.13 | The example becomes a real site of manholes | The Example button now lays out a live data-centre model: 105 manholes at their true positions and rotations, with their Revit marks and types, in place of the three test manholes. A mark that appears twice keeps its name with a count rather than being renamed. |
| v2.14 | Examples, elevations and a 3D window of their own | The example drawings move into an Examples window of their own, with the AMS01 site, the DCBuild model and the demo drawing each a press away. Right-click a face for its elevation: a window showing the face, the dotted boundary box its conduits must keep to and every conduit to scale, where a click selects the run, and asking for another face changes the view to it. The 3D view now opens in a window that can be stretched to any size, draws every buffer zone as a dotted box, and lets a click pick a conduit run as readily as a chamber. |
| v2.15 | The LV site, with room for its sub-models | The example site is now the LV site, built from sub-models: the LV model is the first, the MV model can join it later, and each can be added to the drawing on its own or the whole site placed at once. |
| v2.16 | Orbit the Revit way, about what is selected | In the 3D window, shift with the middle button now orbits and the middle button alone pans, as in Revit, and whatever is selected becomes the pivot, so the view turns about that chamber, obstacle or run. The elevation shows the whole face from lid to base at true scale, with each level's depth marked, rather than stopping at the conduits. |
| v2.17 | Runs never lean, they bend or say why | A run between square faces no longer tilts to swallow a small offset: it bends, and where the offset is too small for the gentlest dogleg the entries slide apart along their faces to make room for one. When the faces cannot give that much, or the run is too short to carry a dogleg, the run says exactly what is missing instead of leaning. |
| v2.18 | The archive habit becomes a skill | The way every version's prompt, reply, model attribution and input files are kept with its release is now written down as a skill and saved with the repository, so any future session, here or in another project, keeps the archive the same way. |
| v2.19 | Shift holds the line, Revit manholes can lock | Hold shift while dragging a chamber or obstacle and it keeps to one line, straight along or straight across, as in Revit. A new Lock manholes switch in the Drawing window keeps every manhole where its Revit export put it: it can be selected and connected but not dragged, nudged or typed into a new position, and only a fresh import moves it. |
| v2.20 | One custom bend, only where the angle demands | Two manholes set at an odd angle to each other can now be joined: the run takes one custom bend that makes up exactly the difference, and only when standard fittings cannot make it. Everything else about the run, including any detour around an obstacle, is still made of standard bends, and each custom fitting is flagged on the run. |
| v2.21 | The MV model brings its conduits, row by row | The MV model joins the site from its IFC: its manholes, vaults and pull boxes at their true positions and depths, and, with a checkbox, the conduit banks that join them recreated as runs. Runs are now laid out row by row: say how many conduits sit in each row, every row lines up on the same columns, and a shorter row packs to the side that suits the next manhole, or the side you choose. |
| v2.22 | The array is drawn, and edited by clicking | A run's rows and columns are no longer typed in: the run's panel shows its section as a picture, one circle per conduit, and a click on a dotted slot adds a conduit or a row while a click on the last conduit of a row takes it away. The picture is seen along the run, so a shorter row sits on the side it really sits on. |
| v2.23 | A wipe button where the examples are | The Examples window now carries a Wipe button: one press, after asking, clears every chamber, obstacle and run so an example or a sub-model can be placed on an empty drawing, and Undo brings the old drawing back. |
