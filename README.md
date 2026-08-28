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
prompt text/             provenance: one folder per version
  <N>/input.txt          the prompt that produced version N, verbatim
  <N>/output.txt         the reply that shipped it, verbatim
  <N>/ai model.txt       the model attribution for that version
  <N>/*.png              input images referenced by the prompt, where held
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
production. Releases are tagged `v1.0`, `v1.1`, … — one per push to `main` —
so the release history is the version history of the page.

## External resources

None. The page loads no external fonts, scripts, or images — the `"Inter"`
font-family declaration intentionally falls back to system fonts. There is no
sitemap; `robots.txt` simply allows crawling.
