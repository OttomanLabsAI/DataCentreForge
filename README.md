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
tools/ifc/               reads the fibre model's IFC into the MV example (not served)
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

Obstacles are drawn in the tool itself; the exporter carries only the
manholes.

The MV model arrived as an IFC rather than a Revit export.
`tools/ifc/extract_mv_example.py` reads an IFC 2x3 file from Revit — the
manhole, vault and pull-box families with their placements, sizes and depths,
and the conduit segments and bends with their port connections — chains the
conduits into runs, joins the runs that stop at a wall sleeve, matches each end
to the chamber face it enters, and writes the example file: every chamber as a
family instance with its own lid, base and top-row depth, and every bank that
joins two chambers as one run with the number of conduits in each row and
its modelled centreline, averaged across the bank's conduits. Runs that leave
the model with an open end are counted but not written. An export may give an
instance its own `lid_mm`, `base_mm` and `z0_mm`, a family its `spacing_mm`,
and a `runs` list with a `path_mm` per run; the tool honours all of them, and
a run placed static keeps that path as its route.

Every manhole and obstacle keeps its Revit element id, unique id and source
document. Importing a later export of the same model refreshes the matching
elements in place — runs stay attached — adds what is new and keeps what the
export no longer has; the tool's own JSON export carries those ids on every
element and on both ends of every run, plus the list of source documents.

## The ribbon and the radial menu

The ribbon across the top is grouped Revit-style — Create, View, Manage,
Settings — with an icon on every button. Every panel is a window opened from
its Manage or Settings button (Chambers, Runs, Obstacles, Specs, Drawing,
File), so the drawing takes the whole width; open as many as you like and drag
them by their title bars. Selecting a chamber, obstacle or run on the plan
lights the buttons that concern it, and their windows show its editor when
opened.

Drag on empty space to select: left to right is a window (only what lies
wholly inside), right to left a crossing (anything the box touches), and the
selected set moves, nudges and deletes together. Pan with a middle- or
right-button drag; zoom with the wheel, a touchpad pinch or two fingers.
The Examples window places the exports kept in `public/examples/`: the LV
model of 105 manholes at their true positions and rotations, carrying their
Revit marks, types and element ids; the MV model read from its IFC — 23
manholes, 44 vaults and 8 pull boxes, and the 77 conduit banks that join
them, recreated as runs while its checkbox is ticked; and the DCBuild test
model. The LV model's family exposes only its depth planes, so it borrows the
DCBuild family's side planes for wall and size.

Hold ctrl (or ⌘) with shift while dragging and the line follows the grabbed
chamber's own axes instead, along or across it however it is turned.
Hold shift while dragging a chamber or obstacle and it keeps to one line,
straight along or straight across, whichever the drag favours. The Drawing
window's **Lock manholes** switch is for drawings fed from Revit: with it on, a
manhole can be selected, connected and deleted but not dragged, nudged or
typed into a new position, and only a fresh import moves it. The lock is saved
with the drawing's export and shows as a small padlock on the Chambers button.

On an iPad, or any touch screen, the same tool works by hand. A tap selects; a
one-finger drag on empty space draws the selection box (left to right a window,
right to left a crossing); a one-finger drag on a chamber or obstacle moves it;
two fingers pan, and pinch to zoom. A finger held still for half a second opens
the ring wherever it rests — a face, a chamber, an obstacle, a run or empty
space — standing in for the right-click, and the ring's delete entry removes the
whole selection when several things are selected. The 3D view follows the same
rules: one finger orbits, two fingers pan and zoom. Windows are dragged by their
title bars with a finger too. With a trackpad or mouse attached, the desktop
gestures apply as they are.

Right-click anything on the drawing for a ring of choices around the cursor:
a chamber (edit, runs, duplicate, fit, delete), an obstacle (edit, its default
around/over/under, duplicate, delete), a run (edit, place, spec, disconnect),
empty space (a chamber or obstacle here, 3D, fit, runs). Right-click a face to
connect from it; then right-click or click the other face to complete the
run. Escape cancels.

The quicker way to connect is a double-click: double-click a face and a
connection begins there, double-click (or single-click) a face on another
chamber and the run is made and placed on the spot, routed and selected. On a
touch screen a double-tap begins it and a tap completes it. There is nothing
to approve: the second face is the approval. Double-clicking the pending face
again lets go, and a pair that already exists is selected rather than
duplicated.

Undo and redo sit beside the title and answer Ctrl+Z, Ctrl+Y and
Ctrl+Shift+Z (Cmd on a Mac). Every change to the drawing is a step: runs made
or disconnected, chambers and obstacles added, moved, edited or deleted, specs
changed, a file or Revit export loaded, the example placed. A drag is one step
however far it goes, and figures typed into one field in quick succession are
one step. The view, the selection and the open windows are left alone, so undo
never moves the drawing about.

## Windows

Every panel is a window opened from the ribbon and dragged by its title bar,
with as many open as you like. Three of them deserve a word:

- **Examples** (in the Manage group) lists the drawings kept with the site:
  the LV site, the DCBuild test model and the demo drawing. The LV site is
  built from sub-models, one export per service: the LV model of 105 manholes
  and the MV model of 75 chambers from the fibre IFC, whose checkbox recreates
  its 77 conduit banks as runs, each with its rows as the model has them.
  Place the whole site, or Add a sub-model to whatever is on the drawing (a
  sub-model already there is refreshed in place, its banks with it). Each
  sub-model is placed dynamic or static, chosen beside its Add button: dynamic
  lets the tool route its runs and move its manholes; static places the model
  as modelled — its manholes stay put, its conduit banks keep their modelled
  centrelines and are never re-routed, and every dynamic run keeps clear of
  them whatever the pipe-avoidance setting. Any number of models can be
  static and any number dynamic, and re-adding a model with the other choice
  switches it. Placing replaces the drawing after asking; a Wipe button at the
  top of the window clears it first, also after asking, and Undo brings the
  previous drawing back either way.
- **Elevation** shows one face at a time: its runs with their level controls
  and the whole face at true scale, lid to base, with each level's depth marked,
  every conduit at its own depth and offset, and the boundary box its conduits
  must keep to (the family's conduit window, or the clear area inside the edge
  clearance) dotted.
  Open it from a face's right-click ring or a side button in the Chambers
  window; asking for another face replaces the view. Click a conduit or a row
  to select its run.
- **3D view** opens from the ribbon or key 3 in a window of its own that can be
  stretched by the grip in its corner. Drag or shift+middle drag to orbit,
  middle or right drag to pan, scroll or pinch to zoom, click a chamber,
  obstacle or run to select it, right-click or hold for the ring. Whatever is
  selected becomes the pivot the view turns about. Every buffer zone is drawn
  as a dotted box.

## Where runs meet a face

A run meets each of its faces where it lines up with the far face, so two
chambers a little out of line still get a dead-straight duct: the offset is
split between the two ends and held within each face's extent — the Revit
conduit window where the family has one, otherwise the face width less the
edge clearance. Bends carry only what the extents cannot absorb. Runs sharing
a face keep their order and pitch, each as close to its own alignment as the
others allow.

A run's array is set up on a picture of its section: one circle per conduit,
rows stacked as they sit, seen along the run from its first chamber so left is
left. A dotted slot at the open end of a row adds a conduit to that row, the
slot beneath adds a row, and the last conduit of a row takes it away, so a
bank can be 3 over 2 as readily as 8, 8 and 8. Every row sits on the same
columns at the face's pitch, so the conduits line up vertically, and a shorter
row sits against one side — by default the side the next manhole lies on, or,
when it lies straight ahead, the side away from the face's other runs — or the
left or right chosen on the run. The elevation and the 3D view draw exactly
those conduits, and the drawing's file carries the rows and the side.

A spec carries an encasement offset — the MV spec has 100 mm by default —
and the Encase button in the Create group puts the box on runs: the selected
runs, the runs on the selected chambers, or every run when nothing is
selected; pressed again on the same runs it takes the box off, and a spec
with no offset is given 100 mm the first time one of its runs is encased. An
encased run's box is a rectangle that far beyond the conduits' outer
diameter, as wide as the array's widest row and as high as all its rows
together. The plan draws it as a band with its two edges, the elevation as a
box round the array, the 3D view as the box's four edges, and the run's panel
and the file give its size; in 3D it is drawn as a solid box around the run.
Other runs avoid the box itself rather than the conduits and their clearance,
obstacles and the ground cover allow for it, and an unencased neighbour keeps
its own clearance from the box. A model can carry its encasement with it: the
MV export marks every bank as encased with its offset, so the model arrives
with its boxes already on.

## Layers

Every chamber, run and obstacle belongs to a layer, like a Revit workset. The
Layers window (in the Manage group) lists them with their counts: each can be
renamed, shown or hidden, made the active layer that new elements go to, or
deleted, which sends what was on it to the Drawing layer, and the selection
can be moved to any of them. Each model placed from the Examples window or a
Revit import lands on a layer of its own, static or dynamic as chosen.

The Models window (also in Manage) shows the same layers as models. Each has
a tick that hides the whole model and four more for its manholes, conduits,
encasement and obstacles on their own, so a model's conduits can be studied
with its chambers out of the way; hiding a model's conduits hides their
encasement with them. Select takes everything shown on that model as the
selection. Hiding changes nothing about routing: a static model stays a
keep-out whether it is shown or not.

A layer is dynamic or static. A dynamic layer is the tool's to route and its
manholes can move. A static layer's manholes stay put at once, and its runs
are fixed by the one Update routes button: a modelled path is kept, and any
other run is laid without avoidance and then fixed as it stands, so dynamic
runs keep clear of it: every element of a static model — its manholes, its
conduit banks and their encasement — is a keep-out for every dynamic run,
whatever the drawing's own avoidance switches say. Set a layer dynamic again
and Update routes routes its runs afresh round everything static and
encased. The setting only takes
effect on Update, and a layer says how many of its runs are waiting for it.

A static run — one placed from a model with its modelled centreline — is
never routed at all: it sits on its path at its modelled depths, meets each
face where the model put it, and is a keep-out for every dynamic run, which
bends round it as it would round a placed bank. Its panel shows the run as
modelled and offers no fittings, spec or depth to change; the drawing's file
carries the path, so the run comes back static.

A run never tilts. Where two square faces are out of line by more than
sliding can absorb, the run bends, and where the leftover offset is too small
for a dogleg of the gentlest allowed bend, the entries slide the other way,
apart along their faces, until it is enough for one. When their faces cannot
give that much, or the run is too short to carry a dogleg, the run says so
rather than leaning: how far out of line the faces are, what the gentlest
dogleg needs, and what is missing. Faces within half a degree of square count
as square, and a duct between them may skew by that much and no more; in
section a duct may still fall gently between two levels.

Two manholes set at an angle to each other that standard fittings cannot make
are joined with one custom bend, and only then: its angle is whatever is left
of the mismatch after the fewest standard bends that bring it within a right
angle, so a chamber turned 32.9° gets a single 32.9° fitting and one turned
175° gets standard bends for 90° of it and an 85° custom for the rest.
Everything else in such a run, including any detour around an obstacle, is
still standard, and every custom fitting is flagged on the run and named in
its bend list.

## Obstacles in three dimensions

Every obstacle has a top, a bottom, and a default way for runs to pass it —
around (its footprint is a keep-out), over or under — chosen in its panel,
around unless changed. Each run's panel lists every obstacle with an around,
over or under choice for that run alone, overriding the default. Runs sharing
two faces travel as one bank and follow the majority choice; a run asking
otherwise is told so. Over never rises into the ground cover set in the Drawing
panel. The plan is routed first, round everything set to around; the long
section is then built in the chainage–Z plane with the same fittings, straights
and clearances, keeping its bends off the plan's bends where it can and
flagging a compound bend where it cannot. When a dip cannot climb back to the
entry level before the chamber, the run enters lower — down to the conduit
window or the chamber base — and says so. Each run shows its section in its
panel along with its laid length.

**3D view** in the header (or the `3` key) shows the whole drawing in three
dimensions: chambers and obstacles as boxes between their top and bottom
levels, every conduit at its true depth, over the ground grid. Drag to orbit,
shift-drag to pan, scroll to zoom, click to select.

## External resources

None. The page loads no external fonts, scripts, or images — the `"Inter"`
font-family declaration intentionally falls back to system fonts. There is no
sitemap; `robots.txt` simply allows crawling.
