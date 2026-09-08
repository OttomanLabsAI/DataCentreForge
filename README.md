# DataCentreForge

**Manhole plan** — an in-browser drawing board for laying out manhole chambers
and routing the runs between them. Plan view, millimetres, no dependencies:
the whole tool is one page of hand-rolled HTML, CSS and SVG-drawing JavaScript,
served as static files from Cloudflare Workers.

## What's here

```
public/                  everything served
  index.html             the drawing board
  404.html               themed error page
  favicon.svg
  robots.txt
  _headers               security + caching headers
  assets/css/site.css    the page's stylesheet
  assets/js/app.js       the drawing board's code
prompt text/             provenance for the version in service (replaced each release)
  <N>/input.txt          the prompt that produced version N, verbatim
  <N>/output.txt         the reply that shipped it, verbatim
  <N>/ai model.txt       the model attribution for that version
  <N>/*.png              input images referenced by the prompt, where held
tools/revit/             exporter script for Revit (not served)
wrangler.jsonc           assets-only Workers config (no build step, no Worker script)
package.json             wrangler devDependency + dev/deploy scripts
```

The page is supplied by the owner as a single self-contained HTML file. Its
inline stylesheet and script are split out into `assets/` verbatim, and the
asset URLs carry a `?v=` release stamp so the long-lived asset cache busts
cleanly on every release.

## Local development

```bash
npm install
npm run dev        # wrangler dev — serves public/ locally
npm run check      # wrangler deploy --dry-run
```

## Deployment

The repo connects to Cloudflare Workers Builds: every push to `main` deploys to
production.
The site is live at https://datacentreforge.cloudflare-passport599.workers.dev/.
Releases are tagged `v1.0`, `v1.1`, … — one per push to `main` —
so the release history is the version history of the page.

## Revit import

Manholes can be brought in from a Revit project. Run `tools/revit/export_manholes.py`
in Revit (pyRevit, RevitPythonShell, or a Dynamo Python node; Revit 2018–2026)
inside the project, then use **Import Revit JSON** in the tool. The family must
name its reference planes `a1`–`a7`, `b1`–`b7`, `z1`–`z6` and
`a_conduit_boundary_1/2`, `b_conduit_boundary_1/2`, `z_conduit_boundary_1/2`:
`a1`/`a7` and `b1`/`b7` are the external faces, `a2`/`a6` and `b2`/`b6` the
inside faces of the walls, `a3`/`a5` and `b3`/`b5` the lid outline; the
conduit-boundary planes bound the insertion window on the sides perpendicular
to their letter, and the `z` pair gives its height. Coordinates are Revit
internal-origin millimetres.

Obstacles come across in the same file: any placed instance carrying the Yes/No
parameters `obstacle_around`, `obstacle_over`, `obstacle_under` (the
`obstable_` spelling is accepted) is exported as its own bounding box in family
coordinates, with its placement, top and bottom, and those three flags.

## Obstacles in three dimensions

Every obstacle has a top, a bottom, and rules for how a run may pass it:
around, over or under. Around always comes first — a run crosses an
around-obstacle only when nothing gets round it. Where a crossing is allowed,
under is the default and over the fallback; an obstacle allowing nothing is
impassable. The plan is routed first; the long section is then solved with the
same engine in the chainage–Z plane, and each run shows it in its panel along
with its laid length.

**3D view** in the header (or the `3` key) shows the whole drawing in three
dimensions: chambers and obstacles as boxes between their top and bottom
levels, every conduit at its true depth, over the ground grid at Z 0. Drag to
orbit, shift-drag to pan, scroll to zoom, click to select.

## External resources

None. The page loads no external fonts, scripts, or images — the `"Inter"`
font-family declaration intentionally falls back to system fonts. There is no
sitemap; `robots.txt` simply allows crawling.
