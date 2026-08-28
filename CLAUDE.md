# CLAUDE.md

Standing policy for this repository. Read it before making any change here.

## What this repo is

A Cloudflare Workers static-assets site. Everything served lives in `public/`
and there is no build step - the files in that directory are the site. The repo
is connected to Cloudflare Workers Builds, so **every push to `main` deploys to
production**.

```
public/            everything served
  index.html
  404.html
  favicon.svg
  robots.txt
  _headers         security + caching headers
  assets/css|js
prompt text/       provenance archive, one numbered folder per version
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

Each version N of the page has a folder `prompt text/N/` (N is the owner's
version number) added in the release that ships it:

- `input.txt` — the prompt that produced the version, byte-for-byte as supplied
- `output.txt` — the reply that shipped it, byte-for-byte as supplied
- `ai model.txt` — the model attribution the owner specifies for that version
- input images referenced by the prompt, where the owner has provided them

These are owner-supplied records. Never edit, reformat, trim, or "fix" them,
and never regenerate them from memory.

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
