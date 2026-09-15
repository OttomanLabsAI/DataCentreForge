/* ==========================================================================
   MANHOLE PLAN
   Square chambers with wall thickness, rectangular obstacles, and conduit runs
   routed internal face to internal face under a named conduit spec: bore, bend
   radius, minimum straight and the bend angles the spec permits.
   Units: millimetres. World axes: +X east, +Y north.
   ========================================================================== */

const SVG = document.getElementById('svg');
const STAGE = document.getElementById('stage');
/* a finger-first device (an iPad in a browser): touch hints, bigger targets, no hover */
const TOUCH_UI = matchMedia('(pointer: coarse)').matches || matchMedia('(hover: none)').matches;

const C = {
  ink:'#dfe6ef', inkDim:'#8894a4', inkFaint:'#5b6675',
  wall:'#59657a', chamber:'#161d27',
  obsLine:'#a8785e', obsHatch:'#6b4f42', obsFill:'#1d1714',
  sel:'#ffb454', pick:'#35c3e8', bad:'#e0655f', warn:'#e8b34a', ghost:'#4c5a6b',
  pipeBody:'#111820',
  gridMinor:'#1a212b', gridMajor:'#27313f', axisX:'#5c3436', axisY:'#2f5c40',
  mono:'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
};

const ANGLE_OPTIONS = [11.25, 15, 22.5, 30, 45, 60, 90];
const SPEC_COLOURS  = ['#35c3e8','#6bd68a','#d8a0e0','#f0a35e','#e0655f','#9db4d8'];

const state = {
  chambers: [], obstacles: [], connections: [], specs: [],
  layers: [{id:'drawing', name:'Drawing', mode:'dynamic', visible:true}], activeLayer: 'drawing',   // like Revit worksets
  view: {tx:0, ty:0, s:0.04},
  sel: null,            // {kind:'chamber'|'obstacle'|'conn', id} — the primary selection
  selSet: [],           // everything selected, primary included (window / crossing selection)
  rubber: null,         // the selection rectangle being dragged, in screen px
  editSpec: null,
  hoverFace: null,
  mode: 'select',
  pending: null,
  snap: 50,
  showGrid: true, showDims: true, avoidChambers: true, avoidPipes: true, square: true,
  ground: 0, cover: 500,        // ground level and the least cover over any conduit
  lockChambers: false,          // manholes stay where their Revit export put them: selectable, never dragged
  view3d: false,
  cam: {az:32, el:38, s:0.03, cx:0, cy:0, cz:0, px:0, py:0}   // orbit camera for the 3D view
};

let uidSeq = 1;
const uid = () => 'e' + (uidSeq++);
const byUid  = u => state.chambers.find(c => c.uid === u);
const obsBy  = u => state.obstacles.find(o => o.uid === u);
const connBy = u => state.connections.find(c => c.uid === u);
const specBy = i => state.specs.find(s => s.id === i);
const specOf = cn => specBy(cn.specId) || state.specs[0];
const selIs  = k => state.sel && state.sel.kind === k;
const inSel  = (k, id) => state.selSet.some(x => x.kind === k && x.id === id);

/* ---------- model --------------------------------------------------------- */

function makeChamber(o = {}){
  return Object.assign({uid:uid(), ref:nextRef(), x:0, y:0, intX:1200, intY:1200, wall:150, rot:0, buffer:300, latSpace:450, zSpace:300, edgeClear:150,
                        z0:-600, zLid:0, zBase:-1800}, o);
}
function makeObstacle(o = {}){
  return Object.assign({uid:uid(), name:nextName(), x:0, y:0, w:2400, d:2400, rot:0, buffer:250,
                        zTop:0, zBot:-1500, method:'around'}, o);
}
/* How a run passes an obstacle is chosen on the drawing: every obstacle
   carries a default method — around (its footprint is a plan keep-out), over
   or under — and any run may choose differently for that obstacle alone. */
const METHODS = ['around', 'over', 'under'];
const obsMethod = o => METHODS.includes(o.method) ? o.method
  : (o.around !== false ? 'around' : o.under !== false ? 'under' : o.over !== false ? 'over' : 'around');   // older flags
const runMethod = (cn, o) => (cn.cross && METHODS.includes(cn.cross[o.uid])) ? cn.cross[o.uid] : obsMethod(o);
/** What a bank does at an obstacle: what most of its runs ask for, the first
    run breaking a tie; a run asking otherwise is told so. */
function bankMethod(G, o){
  const votes = {};
  for (const cn of G.members){ const m = runMethod(cn, o); votes[m] = (votes[m] || 0) + 1; }
  let best = runMethod(G.members[0], o);
  for (const m of METHODS) if ((votes[m] || 0) > (votes[best] || 0)) best = m;
  return best;
}
const chamberZ0 = c => Number.isFinite(c.z0) ? c.z0 : -600;
const chamberZs = c => [Number.isFinite(c.zBase) ? c.zBase : -1800, Number.isFinite(c.zLid) ? c.zLid : 0];   // [base, lid]
function makeSpec(o = {}){
  return Object.assign({
    id:uid(), name:'New spec', colour:SPEC_COLOURS[state.specs.length % SPEC_COLOURS.length],
    radius:150, bendR:600, stub:500, minLeg:500, buffer:300, spacing:300, warnAngle:45, angles:[22.5,45,90], enc:0
  }, o);
}
/* ---------- layers: every element belongs to one, like a Revit workset ---------- */
const DEFAULT_LAYER = 'drawing';
const makeLayer = o => Object.assign({id:uid(), name:'Layer', mode:'dynamic', visible:true}, o);
const layerById = id => state.layers.find(l => l.id === id) || null;
const layerOf = el => (el && layerById(el.layer)) || layerById(DEFAULT_LAYER) || state.layers[0] || null;
const layerMode = el => { const l = layerOf(el); return l && l.mode === 'static' ? 'static' : 'dynamic'; };
const KIND = el => el && el.a && el.b ? 'runs' : (el && el.intX != null ? 'chambers' : 'obstacles');
const isVisible = el => { const l = layerOf(el); if (!l || l.visible === false) return !l; return !l.show || l.show[KIND(el)] !== false; };
/** A run's encasement shows with its run, unless the model hides its encasement. */
const showEnc = cn => { const l = layerOf(cn); return isVisible(cn) && (!l || !l.show || l.show.encasement !== false); };
const activeLayerId = () => layerById(state.activeLayer) ? state.activeLayer : DEFAULT_LAYER;
/** The layer of this name, made when there is none; a mode given sets it. */
function ensureLayer(name, mode){
  let l = state.layers.find(x => String(x.name).toLowerCase() === String(name).toLowerCase());
  if (!l){ l = makeLayer({name:String(name)}); state.layers.push(l); }
  if (mode) l.mode = mode === 'static' ? 'static' : 'dynamic';
  return l;
}
const docLayerName = src => String((src && (src.document || src.source)) || 'Import').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
function nextRef(){
  let n = 1; const used = new Set(state.chambers.map(c => c.ref));
  while (used.has('MH'+String(n).padStart(2,'0'))) n++;
  return 'MH'+String(n).padStart(2,'0');
}
function nextName(){
  let n = 1; const used = new Set(state.obstacles.map(o => o.name));
  while (used.has('OBS'+String(n).padStart(2,'0'))) n++;
  return 'OBS'+String(n).padStart(2,'0');
}

/* ==========================================================================
   GEOMETRY
   Faces are named in the chamber's LOCAL frame: N=+Y, E=+X, S=-Y, W=-X.
   faceGeom() returns the INTERNAL face — the inside surface of that wall.
   ========================================================================== */

const FACES = ['A','B','C','D'];
const legacyFace = f => ({N:'A', E:'B', S:'C', W:'D'}[f] || f);   // old exports used compass names
const D2R = Math.PI/180, R2D = 180/Math.PI;
const norm = v => { const L = Math.hypot(v[0],v[1]) || 1; return [v[0]/L, v[1]/L]; };
const rotv = (v,d) => { const r = d*D2R, c = Math.cos(r), s = Math.sin(r);
                        return [v[0]*c - v[1]*s, v[0]*s + v[1]*c]; };
const wrap = a => { a = ((a+180)%360 + 360)%360 - 180; return a === -180 ? 180 : a; };
const signedAngle = (a,b) => wrap(Math.atan2(a[0]*b[1]-a[1]*b[0], a[0]*b[0]+a[1]*b[1]) * R2D);

function localFace(c, f){
  const a = c.intX/2, b = c.intY/2;
  return {A:{p1:[-a,b], p2:[a,b], n:[0,1]},  B:{p1:[a,b], p2:[a,-b], n:[1,0]},
          C:{p1:[a,-b], p2:[-a,-b], n:[0,-1]}, D:{p1:[-a,-b], p2:[-a,b], n:[-1,0]}}[f];
}
function toWorld(c, p){
  const r = c.rot*D2R, co = Math.cos(r), si = Math.sin(r);
  return [c.x + p[0]*co - p[1]*si, c.y + p[0]*si + p[1]*co];
}
function faceGeom(c, f){
  const lf = localFace(c, f);
  const p1 = toWorld(c, lf.p1), p2 = toWorld(c, lf.p2), n = rotv(lf.n, c.rot);
  const mid = [(p1[0]+p2[0])/2, (p1[1]+p2[1])/2];
  return {mh:c.uid, ref:c.ref, face:f, p1, p2, mid, n,
          width: Math.hypot(p2[0]-p1[0], p2[1]-p1[1]),
          outerMid: [mid[0]+n[0]*c.wall, mid[1]+n[1]*c.wall],
          bearing: (450 - Math.atan2(n[1], n[0])*R2D) % 360};
}
function corners(c, inset){
  const a = c.intX/2 + inset, b = c.intY/2 + inset;
  return [[-a,-b],[a,-b],[a,b],[-a,b]].map(p => toWorld(c, p));
}
function boxCorners(o, grow){
  const a = o.w/2 + grow, b = o.d/2 + grow;
  return [[-a,-b],[a,-b],[a,b],[-a,b]].map(p => toWorld(o, p));
}
function pointInPoly(pt, poly){
  let inside = false;
  for (let i = 0, j = poly.length-1; i < poly.length; j = i++){
    const [xi,yi] = poly[i], [xj,yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj-xi)*(pt[1]-yi)/(yj-yi) + xi) inside = !inside;
  }
  return inside;
}
function segSegDist(p1, p2, q1, q2){
  const d1 = [p2[0]-p1[0], p2[1]-p1[1]], d2 = [q2[0]-q1[0], q2[1]-q1[1]], r = [p1[0]-q1[0], p1[1]-q1[1]];
  const a = d1[0]*d1[0]+d1[1]*d1[1], e = d2[0]*d2[0]+d2[1]*d2[1], f = d2[0]*r[0]+d2[1]*r[1];
  let sN, tN;
  if (a <= 1e-12 && e <= 1e-12) return Math.hypot(r[0], r[1]);
  if (a <= 1e-12){ sN = 0; tN = Math.max(0, Math.min(1, f/e)); }
  else {
    const c = d1[0]*r[0]+d1[1]*r[1];
    if (e <= 1e-12){ tN = 0; sN = Math.max(0, Math.min(1, -c/a)); }
    else {
      const b = d1[0]*d2[0]+d1[1]*d2[1], den = a*e - b*b;
      sN = den > 1e-12 ? Math.max(0, Math.min(1, (b*f - c*e)/den)) : 0;
      tN = (b*sN + f)/e;
      if (tN < 0){ tN = 0; sN = Math.max(0, Math.min(1, -c/a)); }
      else if (tN > 1){ tN = 1; sN = Math.max(0, Math.min(1, (b - c)/a)); }
    }
  }
  return Math.hypot(p1[0]+d1[0]*sN - (q1[0]+d2[0]*tN), p1[1]+d1[1]*sN - (q1[1]+d2[1]*tN));
}
function polyBounds(pts){
  let x0=1e15, y0=1e15, x1=-1e15, y1=-1e15;
  for (const p of pts){ x0=Math.min(x0,p[0]); x1=Math.max(x1,p[0]); y0=Math.min(y0,p[1]); y1=Math.max(y1,p[1]); }
  return [x0, y0, x1, y1];
}
/** Drop a length off each end of a polyline (frees the shared-chamber zone). */
function clipEnds(pts, front, back){
  const cum = [0];
  for (let i = 1; i < pts.length; i++)
    cum.push(cum[i-1] + Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]));
  const total = cum[cum.length-1];
  if (front + back >= total - 1) return null;
  const at = L => {
    let i = 1; while (i < cum.length-1 && cum[i] < L) i++;
    const t = (L - cum[i-1]) / Math.max(1e-9, cum[i]-cum[i-1]);
    return [pts[i-1][0] + (pts[i][0]-pts[i-1][0])*t, pts[i-1][1] + (pts[i][1]-pts[i-1][1])*t];
  };
  const a = front, b = total - back, out = [at(a)];
  for (let i = 0; i < pts.length; i++) if (cum[i] > a && cum[i] < b) out.push(pts[i]);
  out.push(at(b));
  return out;
}
function lineLineDist(A, B, stop){
  let m = Infinity;
  for (let i = 0; i < A.length-1; i++)
    for (let j = 0; j < B.length-1; j++){
      const d = segSegDist(A[i], A[i+1], B[j], B[j+1]);
      if (d < m){ m = d; if (m < stop) return m; }
    }
  return m;
}
function distToSeg(p, a, b){
  const vx = b[0]-a[0], vy = b[1]-a[1], wx = p[0]-a[0], wy = p[1]-a[1];
  const L2 = vx*vx + vy*vy;
  const t = L2 ? Math.max(0, Math.min(1, (wx*vx + wy*vy)/L2)) : 0;
  return Math.hypot(p[0]-(a[0]+t*vx), p[1]-(a[1]+t*vy));
}

/* ==========================================================================
   CONDUIT ROUTING
   Leaves the internal face along its outward normal, arrives at the far
   internal face along the inward normal, changes direction only by an angle
   the spec permits, keeps every straight at or above the minimum, and stays
   clear of every keep-out: conduit radius plus the larger of the two buffer zones.
   The same engine solves the long section (see THE THIRD DIMENSION below).
   ========================================================================== */

const SAMPLES = 10, SEQ_CAP = 300, BUDGET = 30000;
/* Route cost, in millimetres of conduit: every bend is worth this much extra
   length, and a bend that trips a warning far more — so the router only
   reaches for a big or over-limit bend when it saves serious run length. */
const BEND_COST = 1500, ANGLE_COST = 4000, RADIUS_COST = 3000, CUSTOM_COST = 6000;
/* Straights are king: run length spent OFF the run's own axes (the directions
   it leaves and enters the manholes on) is charged this multiplier, so the
   router steps aside briefly and runs straight, instead of sailing off on a
   long diagonal or tenting over an obstacle. */
const OFF_AXIS_COST = 1.6;
/* In section a duct may fall gently: two levels this close to level (about 2°)
   take one straight duct. On the plan a run never tilts: a straight duct is
   allowed only where the two faces themselves are within half a degree of
   square, and only by that much — a lateral offset is answered with bends,
   the entries sliding apart along their faces to make room for them. */
const SKEW_TAN = Math.tan(2*D2R), PLAN_SKEW_DEG = 0.5;
let ROUTE_QUICK = false;   // while dragging: smaller search, no fine pass

function solve2(u, v, r){
  const det = u[0]*v[1] - u[1]*v[0];
  if (Math.abs(det) < 1e-9) return null;
  return [(r[0]*v[1]-r[1]*v[0])/det, (u[0]*r[1]-u[1]*r[0])/det];
}
function dirsFrom(d0, turns){
  const ds = [d0]; let c = d0;
  for (const t of turns){ c = rotv(c, t); ds.push(c); }
  return ds;
}
function segBox(p, q, hw, hh){
  let t0 = 0, t1 = 1; const d = [q[0]-p[0], q[1]-p[1]], h = [hw, hh];
  for (let i = 0; i < 2; i++){
    const lo = -h[i]-p[i], hi = h[i]-p[i];
    if (Math.abs(d[i]) < 1e-9){ if (lo > 0 || hi < 0) return false; }
    else { let a = lo/d[i], b = hi/d[i];
      if (a > b){ const t = a; a = b; b = t; }
      t0 = Math.max(t0,a); t1 = Math.min(t1,b);
      if (t0 > t1) return false; }
  }
  return true;
}
function hitsBlocker(p, q, B){
  const c = Math.cos(-B.rot*D2R), s = Math.sin(-B.rot*D2R);
  const lp = [(p[0]-B.cx)*c - (p[1]-B.cy)*s, (p[0]-B.cx)*s + (p[1]-B.cy)*c];
  const lq = [(q[0]-B.cx)*c - (q[1]-B.cy)*s, (q[0]-B.cx)*s + (q[1]-B.cy)*c];
  return segBox(lp, lq, B.hw+B.margin, B.hh+B.margin);
}
function clearOf(poly, blockers){
  let bb = null;
  for (const B of blockers){
    if (B.type === 'line'){
      if (!bb) bb = polyBounds(poly);
      if (bb[0] > B.bb[2]+B.margin || bb[2] < B.bb[0]-B.margin ||
          bb[1] > B.bb[3]+B.margin || bb[3] < B.bb[1]-B.margin) continue;
      for (let i = 0; i < poly.length-1; i++)
        for (let j = 0; j < B.pts.length-1; j++)
          if (segSegDist(poly[i], poly[i+1], B.pts[j], B.pts[j+1]) < B.margin) return false;
    } else {
      for (let i = 0; i < poly.length-1; i++)
        if (hitsBlocker(poly[i], poly[i+1], B)) return false;
    }
  }
  return true;
}

/** Minimum length of each straight as routed: ends are measured off the
    chamber face, interiors between bends. Interior legs ALWAYS reserve the
    full bend tangents on top of the minimum straight, so consecutive bends
    run at full radius with real straight duct between them. End legs reserve
    only the stub (their tangent shortfall is an amber radius cut instead),
    unless strict mode asks for the tangents there too. */
function segMins(turns, spec, strict){
  const n = turns.length + 1;
  const T = turns.map(t => spec.bendR * Math.tan(Math.abs(t)*D2R/2));
  const lo = [];
  for (let i = 0; i < n; i++){
    const end = (i === 0 || i === n-1);
    const base = Math.max(1, end ? spec.stub : spec.minLeg);
    const tans = (i > 0 ? T[i-1] : 0) + (i < n-1 ? T[i] : 0);
    lo.push(end && !strict ? base : base + tans);
  }
  return lo;
}

/** Fillet every bend. Where the run is too short to carry both the bend and
    the minimum straight, the straight is kept and the radius is cut back —
    with a warning naming the bend. */
function applyFillets(sol, spec){
  const {segs, turns} = sol, n = segs.length;
  const want = turns.map(t => spec.bendR * Math.tan(Math.abs(t)*D2R/2));
  const scale = turns.map(() => 1);
  for (let i = 0; i < n; i++){
    const a = i-1, b = i < turns.length ? i : -1;
    const need = (a >= 0 ? want[a] : 0) + (b >= 0 ? want[b] : 0);
    const min = Math.max(1, (i === 0 || i === n-1) ? spec.stub : spec.minLeg);
    const avail = Math.max(0, segs[i] - min);
    if (need > avail + 1e-9){
      const f = need > 0 ? avail/need : 0;
      if (a >= 0) scale[a] = Math.min(scale[a], f);
      if (b >= 0) scale[b] = Math.min(scale[b], f);
    }
  }
  const fillets = [], warnings = [];
  let length = segs.reduce((x,y) => x+y, 0);
  for (let i = 0; i < turns.length; i++){
    const d = Math.abs(turns[i])*D2R, th = Math.tan(d/2);
    const T = want[i]*scale[i], R = th > 1e-9 ? T/th : 0;
    fillets.push({R, T, deflect: Math.abs(turns[i]), cut: scale[i] < 1-1e-6});
    if (scale[i] < 1-1e-6) warnings.push({kind:'radius', bend:i+1,
      text:`bend ${i+1} — R${fmt(spec.bendR)} will not fit beside the minimum straights, cut to R${fmt(R)}`});
    if (spec.warnAngle && Math.abs(turns[i]) > spec.warnAngle+1e-6) warnings.push({kind:'angle', bend:i+1,
      text:`bend ${i+1} — ${fmt1(Math.abs(turns[i]))}° is over the ${fmt1(spec.warnAngle)}° limit`});
    length += R*d - 2*T;
  }
  const clear = segs.map((L,i) => L - (i > 0 ? fillets[i-1].T : 0) - (i < n-1 ? fillets[i].T : 0));
  return {...sol, fillets, clear, length, warnings};
}

/** Centreline as a polyline, arcs included — used for clash and hit testing. */
function tessellate(rt, steps = 4){
  const out = [rt.pts[0].slice()];
  for (let i = 1; i < rt.pts.length-1; i++){
    const f = rt.fillets[i-1], cur = rt.pts[i], prev = rt.pts[i-1], nxt = rt.pts[i+1];
    if (f.T < 1e-6 || f.R < 1e-6){ out.push(cur.slice()); continue; }
    const u = norm([prev[0]-cur[0], prev[1]-cur[1]]), v = norm([nxt[0]-cur[0], nxt[1]-cur[1]]);
    const a1 = [cur[0]+u[0]*f.T, cur[1]+u[1]*f.T], a2 = [cur[0]+v[0]*f.T, cur[1]+v[1]*f.T];
    const bis = norm([u[0]+v[0], u[1]+v[1]]);
    const half = Math.acos(Math.max(-1, Math.min(1, u[0]*v[0]+u[1]*v[1])))/2;
    const dc = f.R/Math.max(1e-9, Math.sin(half));
    const ctr = [cur[0]+bis[0]*dc, cur[1]+bis[1]*dc];
    const a = Math.atan2(a1[1]-ctr[1], a1[0]-ctr[0]), b = Math.atan2(a2[1]-ctr[1], a2[0]-ctr[0]);
    let sweep = b-a;
    while (sweep >  Math.PI) sweep -= 2*Math.PI;
    while (sweep < -Math.PI) sweep += 2*Math.PI;
    for (let k = 0; k <= steps; k++){
      const t = a + sweep*k/steps;
      out.push([ctr[0]+f.R*Math.cos(t), ctr[1]+f.R*Math.sin(t)]);
    }
  }
  out.push(rt.pts[rt.pts.length-1].slice());
  return out;
}
function solveWith(ds, V, ia, ib, fixed){
  const rhs = [V[0], V[1]];
  for (let i = 0; i < ds.length; i++){
    if (i === ia || i === ib) continue;
    rhs[0] -= fixed[i]*ds[i][0]; rhs[1] -= fixed[i]*ds[i][1];
  }
  const r = solve2(ds[ia], ds[ib], rhs);
  if (!r) return null;
  const t = fixed.slice(); t[ia] = r[0]; t[ib] = r[1];
  return t;
}
/** Feasible sets of straight lengths for one turn sequence. ext[i] carries
    the full-radius tangent an END leg would need on top of its minimum:
    those exact values are always offered as samples (with a padded variant),
    so an uncut end bend is reachable no matter how coarse the span sweep is.
    Any third free segment is held at its minimum but still gets the tangent
    options — previously it was pinned with no way to buy bend room. */
function candidates(P, d0, V, turns, lo, fine, ext, skewTan = SKEW_TAN){
  const ds = dirsFrom(d0, turns), n = ds.length, res = [];
  const span = Math.max(3000, Math.hypot(V[0],V[1])*1.5);
  const NS = fine ? 30 : SAMPLES, GS = fine ? 9 : 4;
  const build = ts => {
    const pts = [P.slice()];
    for (let i = 0; i < n; i++){ const p = pts[i]; pts.push([p[0]+ds[i][0]*ts[i], p[1]+ds[i][1]*ts[i]]); }
    return {turns, pts, segs: ts.slice()};
  };
  const push = t => { if (t && t.every((v,i) => v >= lo[i]-1e-6)) res.push(build(t)); };

  if (n === 1){
    const cr = d0[0]*V[1]-d0[1]*V[0], dot = d0[0]*V[0]+d0[1]*V[1];
    if (dot >= lo[0] && Math.abs(cr) <= Math.max(1, dot*skewTan))
      res.push({turns, pts:[P.slice(), [P[0]+V[0], P[1]+V[1]]], segs:[Math.hypot(V[0], V[1])]});
    return res;
  }
  if (n === 2){ push(solveWith(ds, V, 0, 1, [0,0])); return res; }

  const pairs = n === 3 ? [[1,2],[0,2],[0,1]] : n === 4 ? [[1,2],[0,3],[0,2]] : [[1,3],[2,3],[1,2]];
  for (const [ia,ib] of pairs){
    const free = []; for (let i = 0; i < n; i++) if (i !== ia && i !== ib) free.push(i);
    const fixed = lo.slice();
    const valsOf = (f, j) => {
      const v = [];
      const gridN = free.length === 1 ? NS : GS;
      if (j < 2) for (let k = 0; k <= gridN; k++) v.push(lo[f] + span*k/gridN);
      else v.push(lo[f]);
      if (ext && ext[f] > 0){ v.push(lo[f] + ext[f]); v.push(lo[f] + ext[f]*1.5); }
      return v;
    };
    const rec = j => {
      if (j === free.length){ push(solveWith(ds, V, ia, ib, fixed)); return; }
      for (const v of valsOf(free[j], j)){ fixed[free[j]] = v; rec(j+1); }
    };
    rec(0);
  }
  return res;
}
function seqOrder(list, cap){
  const key = s => s.length ? Math.max(...s.map(Math.abs)) : 0;
  const tot = s => s.reduce((a,v) => a+Math.abs(v), 0);
  const groups = new Map();
  for (const s of list){ const k = key(s); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
  const keys = [...groups.keys()].sort((a,b) => a-b);
  const cur = new Map();
  for (const k of keys){ groups.get(k).sort((x,y) => tot(x)-tot(y));
                         cur.set(k, {lo:0, hi:groups.get(k).length-1, flip:0}); }
  /* Round-robin across bend-size families, alternately taking the gentlest and
     the widest sequence left in each — a plain gentlest-first order never
     reaches the wide cranks needed to get past a big obstacle. */
  const out = []; let any = true;
  while (any && out.length < cap){
    any = false;
    for (const k of keys){
      const g = groups.get(k), p = cur.get(k);
      if (p.lo > p.hi) continue;
      out.push(p.flip++ % 2 ? g[p.hi--] : g[p.lo++]);
      any = true;
      if (out.length >= cap) break;
    }
  }
  return out;
}
/** Turn sequences adding up to the required total turn. Runs of three or more
    bends are held to two distinct bend sizes — nobody details one leg with
    five different fittings. */
function sequences(signed, delta, count){
  const out = [];
  if (count === 0){ if (Math.abs(wrap(delta)) < 1e-6) out.push([]); return out; }
  const rec = (acc, sum, sizes) => {
    if (acc.length === count){ if (Math.abs(wrap(sum-delta)) < 1e-6) out.push(acc.slice()); return; }
    for (const a of signed){
      const m = Math.abs(a);
      if (count > 2 && !sizes.has(m) && sizes.size >= 2) continue;
      const had = sizes.has(m); if (!had) sizes.add(m);
      acc.push(a); rec(acc, sum+a, sizes); acc.pop();
      if (!had) sizes.delete(m);
    }
  };
  rec([], 0, new Set());
  return seqOrder(out, SEQ_CAP);
}

/* ---------- custom bends ----------
   Two faces at a non-standard angle to each other cannot be joined with
   standard fittings alone, however many are used. Then, and only then, the run
   takes ONE custom bend, made to suit: its angle is what is left of the
   mismatch after the fewest standard bends that bring it within a right
   angle (the smallest remainder wins). Every other bend in such a run,
   including any detour around an obstacle, is a standard fitting, because the
   custom bend's angle is fixed before routing and the standard bends must sum
   to exactly their share. */
const isCustomTurn = (t, angles) => !(angles || []).some(a => Math.abs(Math.abs(t) - a) < 1e-6);
function customFor(delta, signed){
  if (Math.abs(wrap(delta)) < 1e-6) return null;
  for (let n = 1; n <= 4; n++) if (sequences(signed, delta, n).length) return null;   // standard fittings can make it
  const sums = k => { let acc = new Set([0]); for (let i = 0; i < k; i++){ const nx = new Set(); for (const s of acc) for (const a of signed) nx.add(Math.round(wrap(s + a)*1e6)/1e6); acc = nx; } return [...acc]; };
  for (let k = 0; k <= 3; k++){
    let best = null;
    for (const S of sums(k)){
      const c = wrap(delta - S);
      if (Math.abs(c) <= 90 + 1e-6 && Math.abs(c) >= PLAN_SKEW_DEG && (!best || Math.abs(c) < Math.abs(best.c) - 1e-9)) best = {c, S};
    }
    if (best) return best;
  }
  return null;
}
/** Turn sequences of n bends carrying the one custom bend: standard bends summing to its share, the custom anywhere among them. */
function customSequences(signed, cu, n){
  const out = [], seen = new Set();
  for (const base of sequences(signed, cu.S, n-1))
    for (let p = 0; p <= base.length; p++){
      const seq = base.slice(); seq.splice(p, 0, cu.c);
      const k = seq.map(v => v.toFixed(4)).join(','); if (seen.has(k)) continue; seen.add(k); out.push(seq);
      if (out.length >= SEQ_CAP) return out;
    }
  return out;
}

function search(P, d0, V, delta, signed, spec, blockers, strict, skewTan = SKEW_TAN, cu = null){
  let sawSolution = false, sawBlocked = false, best = null;
  let budget = ROUTE_QUICK ? 6000 : BUDGET;
  const straightLine = Math.hypot(V[0], V[1]);
  const ax1 = norm(d0), ax2 = norm(rotv(d0, delta));
  const COS = Math.cos(2*D2R);
  const scoreOf = f => {
    let eff = (f.length - f.segs.reduce((a,b) => a+b, 0)) * OFF_AXIS_COST;  // arcs are transitions
    for (let i = 0; i < f.segs.length; i++){
      const u = norm([f.pts[i+1][0]-f.pts[i][0], f.pts[i+1][1]-f.pts[i][1]]);
      const aligned = Math.abs(u[0]*ax1[0]+u[1]*ax1[1]) > COS || Math.abs(u[0]*ax2[0]+u[1]*ax2[1]) > COS;
      eff += f.segs[i] * (aligned ? 1 : OFF_AXIS_COST);
    }
    return eff + BEND_COST*f.turns.length
      + CUSTOM_COST*f.turns.filter(t => isCustomTurn(t, spec.angles)).length
      + ANGLE_COST*f.warnings.filter(w => w.kind === 'angle').length
      + RADIUS_COST*f.warnings.filter(w => w.kind === 'radius').length;
  };
  const evalCands = (seq, fine) => {
    const m = seq.length + 1, ext = Array(m).fill(0);
    if (seq.length){
      const T = t => spec.bendR * Math.tan(Math.abs(t)*D2R/2);
      ext[0] = T(seq[0]); ext[m-1] = T(seq[seq.length-1]);
    }
    for (const sol of candidates(P, d0, V, seq, segMins(seq, spec, strict), fine, ext, skewTan)){
      if (--budget < 0) return;
      sawSolution = true;
      const f = applyFillets(sol, spec);
      f.poly = tessellate(f);
      if (!clearOf(f.poly, blockers)){ sawBlocked = true; continue; }
      if (blockers.accept && !blockers.accept(f)){ sawBlocked = true; continue; }
      f.score = scoreOf(f);
      if (!best || f.score < best.score) best = f;
    }
  };
  /* All bend counts compete on cost, not seniority: a fourth gentle bend
     beats a shorter list of bends that swings kilometres out of the way.
     A count is skipped only when even its best imaginable route — dead
     straight, warning-free — could not beat what is already on the table. */
  for (let n = 0; n <= 4 && budget >= 0; n++){
    if (n > 0 && !signed.length && !cu) break;
    if (best && straightLine + BEND_COST*n >= best.score) break;
    for (const seq of sequences(signed, delta, n)){
      evalCands(seq, false);
      if (budget < 0) break;
    }
    if (cu && n > 0) for (const seq of customSequences(signed, cu, n)){
      evalCands(seq, false);
      if (budget < 0) break;
    }
  }
  if (best && !ROUTE_QUICK){ budget = 3000; evalCands(best.turns, true); }   // fine pass on the winner
  return best ? {ok:true, ...best} : {ok:false, sawSolution, sawBlocked};
}

/** First pass keeps every bend at its full radius clear of the minimum
    straights. Only if nothing fits does it try again with the radii cut
    back, and then it says which bends had to give. */
/** The smallest sideways step a dogleg of the gentlest allowed bend can make, and the run it needs. */
function minDogleg(spec){
  const th = Math.min(...(spec.angles || []).filter(a => a > 0 && a < 180));
  if (!Number.isFinite(th)) return null;
  const lo = segMins([th, -th], spec, false);
  return {angle:th, step: lo[1]*Math.sin(th*D2R), run: lo[0] + lo[2] + lo[1]*Math.cos(th*D2R)};
}
function solveRoute(P, d0, Q, d2, spec, blockers, opt = {}){
  const V = [Q[0]-P[0], Q[1]-P[1]];
  const raw = signedAngle(d0, d2);
  /* on the plan, faces within half a degree of square count as square, and the duct may skew by that much and no more */
  const plan = !!opt.plan, skew = plan ? (Math.abs(raw) < PLAN_SKEW_DEG ? Math.abs(raw) : 0) : 0;
  const delta = plan && skew ? 0 : raw;
  const skewTan = plan ? Math.tan(skew*D2R) : SKEW_TAN;
  const angles = [...new Set(spec.angles)].filter(a => a > 0 && a < 180).sort((a,b) => a-b);
  const signed = []; for (const a of angles) signed.push(a, -a);

  /* One search with relaxed minimums: geometry honouring the full bend radius
     carries no cut and wins on score; tight spots take a scored radius cut
     instead of being unreachable behind a strict-pass shortcut. */
  const cu = plan ? customFor(delta, signed) : null;                  // the one custom bend, when standard fittings cannot make the angle
  const relaxed = search(P, d0, V, delta, signed, spec, blockers, false, skewTan, cu);
  if (relaxed.ok) return relaxed;
  if (plan && Math.abs(delta) < 1e-9 && !relaxed.sawBlocked){       // square faces out of line: say what a dogleg would need
    const cr = Math.abs(d0[0]*V[1]-d0[1]*V[0]), along = d0[0]*V[0]+d0[1]*V[1], md = minDogleg(spec);
    if (cr > 1 && md){
      if (along < md.run)
        return {ok:false, msg:`faces ${fmt(cr)} out of line — a ${fmt1(md.angle)}° dogleg needs ${fmt(md.run)} of run, only ${fmt(along)} here`};
      if (cr < md.step - 1e-6)
        return {ok:false, msg:`faces ${fmt(cr)} out of line — too little for a ${fmt1(md.angle)}° dogleg, which steps at least ${fmt(md.step)}, and the entries can slide no further apart`};
    }
  }
  return {ok:false, msg: relaxed.sawBlocked ? 'blocked — no way past the keep-outs'
    : relaxed.sawSolution ? 'no room — shorten the minimum straights'
    : angles.length ? (cu ? `no route to that face, even with one custom bend of ${fmt1(Math.abs(cu.c))}°` : 'no route to that face with these angles') : 'allow a bend angle'};
}

function faceRuns(mhUid, face){
  return state.connections.filter(c =>
    (c.a.mh === mhUid && c.a.face === face) || (c.b.mh === mhUid && c.b.face === face));
}
/** Where a run actually meets the chamber: runs sharing a face are spread
    along it at the manhole's lateral spacing, ordered so the run heading
    left takes the left slot and entries never cross at the wall. */
/** The array of a run: how many conduits sit in each row, top row first —
    every row on the same columns, a shorter row packed to one side. Older
    drawings gave rows × columns; they read as that many equal rows. */
const runRowsOf = r => Array.isArray(r.perRow) && r.perRow.length
  ? r.perRow.map(n => Math.max(1, Math.round(Number(n)) || 1))
  : Array.from({length: Math.max(1, r.rows|0 || 1)}, () => Math.max(1, r.cols|0 || 1));
const runCols = r => Math.max(...runRowsOf(r));
/** A spec's encasement offset: how far the concrete box round the array stands beyond the conduits' outer diameter; 0 for none. */
const encOf = sp => Math.max(0, Number(sp && sp.enc) || 0);
/** The encasement box of a run, in section: a rectangle `off` beyond the outer
    diameter, as wide as its widest row and as high as all its rows together. */
const isEncased = cn => !!(cn && cn.encased) && encOf(specOf(cn)) > 0;
function runEncasement(cn){
  const sp = specOf(cn), off = encOf(sp);
  if (!off || !cn.encased) return null;
  const ea = entryFor(cn,'a'), eb = entryFor(cn,'b');
  const S = Math.max(ea ? ea.S || 0 : 0, eb ? eb.S || 0 : 0);
  const zPitch = runZSpace(cn);
  const W = (runCols(cn)-1)*S + 2*sp.radius + 2*off, H = (runRows(cn)-1)*zPitch + 2*sp.radius + 2*off;
  return {off, W, H, halfW: W/2, zTop: sp.radius + off, zBot: -(runRows(cn)-1)*zPitch - sp.radius - off};
}
const runRows = r => runRowsOf(r).length;
const runCount = r => runRowsOf(r).reduce((a, b) => a + b, 0);
const arrayText = r => { const rows = runRowsOf(r); return rows.length === 1 ? `${rows[0]} wide` : rows.join(' + '); };
const ALIGNS = ['auto', 'left', 'right'];
/** The centres a run is laid on: the spec's spacing across, the manholes' Z
    spacing down — the same values the Specs and Chambers windows hold, which
    a run's own panel is another place to set. The face takes the largest
    across-spacing of the runs it carries, so they share one grid. */
const posNum = v => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null;
const runSpace  = cn => posNum(specOf(cn) && specOf(cn).spacing) || 300;
const runZSpace = cn => { const A = byUid(cn.a.mh), B = byUid(cn.b.mh);
  return Math.max(1, A ? A.zSpace || 0 : 0, B ? B.zSpace || 0 : 0); };
const runAlignPref = r => ALIGNS.includes(r.align) ? r.align : 'auto';

const canonTangent = g => {
  let t = norm([g.p2[0]-g.p1[0], g.p2[1]-g.p1[1]]);
  if (t[1] < -1e-9 || (Math.abs(t[1]) <= 1e-9 && t[0] < 0)) t = [-t[0], -t[1]];
  return t;
};
/** How far along a face a conduit centreline may sit: the Revit conduit
    window where the family has one (its centre may sit off the face centre),
    else the face width less the edge clearance. Offsets run along the face's
    canonical tangent from the face centre. */
function faceExtent(c, face){
  const g = faceGeom(c, face), t = canonTangent(g);
  const win = c.win && c.win[face] ? c.win[face] : null;
  let shift = 0;
  if (win){
    const lax = (face === 'A' || face === 'C') ? rotv([1,0], c.rot) : rotv([0,1], c.rot);
    shift = win.off * (Math.sign(lax[0]*t[0] + lax[1]*t[1]) || 1);
  }
  const half = win ? win.w/2 : g.width/2 - (c.edgeClear || 0);
  return {g, t, win, shift, lo: shift - half, hi: shift + half,
          centre: [g.mid[0] + t[0]*shift, g.mid[1] + t[1]*shift]};
}
const facePitch = (mhUid, face) => {
  const c = byUid(mhUid), runs = faceRuns(mhUid, face);
  return Math.max(c ? c.latSpace : 0, ...runs.map(runSpace));
};
const runHalf = (cn, S) => (runCols(cn)-1)/2*S + (specOf(cn) ? specOf(cn).radius : 0);

/** Where a run would like to meet this face: the offset that lines it up
    with the far face so it can run straight, split evenly between the two
    ends and held within each face's extent — the shortfall of a clamped end
    passed to the other. Zero when the two faces are not facing each other. */
function alignPref(cn, end){
  const here = cn[end], there = cn[end === 'a' ? 'b' : 'a'];
  const A = byUid(here.mh), B = byUid(there.mh);
  if (!A || !B) return 0;
  const eA = faceExtent(A, here.face), eB = faceExtent(B, there.face);
  const d0 = eA.g.n, d2 = [-eB.g.n[0], -eB.g.n[1]];
  if (d0[0]*d2[0] + d0[1]*d2[1] < Math.cos(15*D2R)) return 0;
  const dir = norm([d0[0]+d2[0], d0[1]+d2[1]]), L = [-dir[1], dir[0]];
  const sA = eA.t[0]*L[0] + eA.t[1]*L[1], sB = eB.t[0]*L[0] + eB.t[1]*L[1];
  if (Math.abs(sA) < 0.5 || Math.abs(sB) < 0.5) return 0;
  const m = (eB.centre[0]-eA.centre[0])*L[0] + (eB.centre[1]-eA.centre[1])*L[1];   // lateral misalignment
  /* reach either side of each extent's centre, less the run's own half width */
  const hwA = (eA.hi - eA.lo)/2 - runHalf(cn, facePitch(here.mh, here.face));
  const hwB = (eB.hi - eB.lo)/2 - runHalf(cn, facePitch(there.mh, there.face));
  const cl = (x, h) => h <= 0 ? 0 : Math.max(-h, Math.min(h, x));
  const u = m/(2*sA), v = -m/(2*sB);
  let u2 = cl(u, hwA), v2 = cl(v, hwB);
  const rem = m - (u2*sA - v2*sB);
  if (Math.abs(rem) > 1e-6){
    if (Math.abs(u2 - u) < 1e-6) u2 = cl(u2 + rem/sA, hwA);
    else if (Math.abs(v2 - v) < 1e-6) v2 = cl(v2 - rem/sB, hwB);
  }
  /* What is left cannot be slid away, so the run must bend — and a dogleg of the
     gentlest bend can only step so little. Rather than tilt, the ends slide the
     other way, apart, until the offset is enough for that dogleg; if their faces
     cannot give that much, or the run is too short for one, they stay as they
     are and the router says why. */
  const sp0 = specOf(cn) || {}, wide = runHalf(cn, facePitch(here.mh, here.face)) - (sp0.radius || 0);   // as buildBanks widens a bank for its lanes
  const r = m - (u2*sA - v2*sB), md = minDogleg({...sp0, bendR:(sp0.bendR||0) + wide, stub:(sp0.stub||0) + wide, minLeg:(sp0.minLeg||0) + wide});
  if (Math.abs(r) > 1e-6 && md && Math.abs(r) < md.step){
    const along = (eB.centre[0]-eA.centre[0])*dir[0] + (eB.centre[1]-eA.centre[1])*dir[1];
    if (along >= md.run){
      const k = m - Math.sign(r)*md.step*1.05;
      const uu = k/(2*sA), vv = -k/(2*sB);
      let u3 = cl(uu, hwA), v3 = cl(vv, hwB);
      const rem3 = k - (u3*sA - v3*sB);
      if (Math.abs(rem3) > 1e-6){
        if (Math.abs(u3 - uu) < 1e-6) u3 = cl(u3 + rem3/sA, hwA);
        else if (Math.abs(v3 - vv) < 1e-6) v3 = cl(v3 - rem3/sB, hwB);
      }
      if (Math.abs(m - (u3*sA - v3*sB)) >= md.step - 1e-6) u2 = u3;
    }
  }
  return u2;                 // relative to the extent's centre; the layout adds the window shift
}

/** Lay items along a face in their given order: each starts where it would
    like to be (items sharing a preference centred on it as a block), then
    the pitch between neighbours and the face's extent are enforced. */
function packSlots(items, S){
  const n = items.length;
  if (!n) return;
  const gap = k => (items[k].cols + items[k+1].cols)/2*S;
  const x = new Array(n);
  for (let i = 0; i < n;){
    let j = i;
    while (j+1 < n && Math.abs(items[j+1].pref - items[i].pref) < 1) j++;
    let total = 0; for (let k = i; k < j; k++) total += gap(k);
    let pos = items[i].pref - total/2;
    for (let k = i; k <= j; k++){ x[k] = pos; if (k < j) pos += gap(k); }
    i = j+1;
  }
  for (let pass = 0; pass < 4; pass++){
    for (let k = 0; k < n; k++){ x[k] = Math.max(x[k], items[k].lo); if (k > 0) x[k] = Math.max(x[k], x[k-1] + gap(k-1)); }
    for (let k = n-1; k >= 0; k--){ x[k] = Math.min(x[k], items[k].hi); if (k < n-1) x[k] = Math.min(x[k], x[k+1] - gap(k)); }
  }
  items.forEach((it, k) => { it.centreOff = x[k]; });
}

/** Everything about how a face carries its conduits: one shared grid whose
    pitch is the LARGEST array spacing among the types present (floored by
    the manhole's lateral spacing), arrays laid in canonical order — each
    where it lines up with its far face, as far as the extent allows —
    stacked by level (level 0 highest). Used by plan entries, the face
    section view, and the width check — so they always agree. */
function faceLayout(mhUid, face){
  const c = byUid(mhUid);
  if (!c) return null;
  const ext = faceExtent(c, face), g = ext.g, t = ext.t, win = ext.win, shift = ext.shift;
  const runs = faceRuns(mhUid, face);
  if (!runs.length) return {c, g, t, S:c.latSpace, groups:[], usedW:0, rowsTotal:0, fits:true, win, shift};
  const S = facePitch(mhUid, face);
  const order = rs => rs.map(r => {
    const far = (r.a.mh === mhUid && r.a.face === face) ? r.b : r.a;
    const oc = byUid(far.mh);
    return {r, proj: oc ? (oc.x-g.mid[0])*t[0] + (oc.y-g.mid[1])*t[1] : 0};
  }).sort((x,y) => x.proj - y.proj || (x.r.uid < y.r.uid ? -1 : 1)).map(k => k.r);
  const levels = [...new Set(runs.map(r => r.level|0))].sort((a,b) => a-b);
  const groups = [];
  let rowsTotal = 0, usedW = 0, fits = true;
  for (const lv of levels){
    const rs = order(runs.filter(r => (r.level|0) === lv));
    let col = 0; const items = [];
    for (const r of rs){
      const end = (r.a.mh === mhUid && r.a.face === face) ? 'a' : 'b';
      const half = runHalf(r, S);
      const fx = fixedOffset(r, end, g, t);
      items.push({cn:r, sp:specOf(r), cols:runCols(r), rows:runRows(r), colStart:col, half, fixed: fx != null,
                  lo: fx != null ? fx : ext.lo + half, hi: fx != null ? fx : ext.hi - half, pref: fx != null ? fx : shift + alignPref(r, end)});
      col += runCols(r);
    }
    const totalCols = col;
    const rMax = Math.max(...items.map(i => i.sp ? i.sp.radius : 0));
    const rowsMax = Math.max(...items.map(i => i.rows));
    packSlots(items, S);
    for (const i of items) if (i.centreOff < i.lo - 1 || i.centreOff > i.hi + 1) fits = false;
    groups.push({level:lv, items, totalCols, rMax, rowsMax});
    rowsTotal += rowsMax;
    usedW = Math.max(usedW, Math.max(...items.map(i => i.centreOff + i.half)) - Math.min(...items.map(i => i.centreOff - i.half)));
  }
  return {c, g, t, S, groups, usedW, rowsTotal, fits, win, shift};
}

/** Where a static run's modelled centreline meets this face, as an offset along the face; null for a run the tool lays out. */
function fixedOffset(cn, end, g, t){
  if (!cn.fixed || !Array.isArray(cn.fixedPath) || cn.fixedPath.length < 2) return null;
  const q = end === 'a' ? cn.fixedPath[0] : cn.fixedPath[cn.fixedPath.length-1];
  return (q[0]-g.mid[0])*t[0] + (q[1]-g.mid[1])*t[1];
}
function entryFor(cn, end){
  const ep = cn[end], c = byUid(ep.mh);
  if (!c) return null;
  const L = faceLayout(ep.mh, ep.face);
  const g = L.g, t = L.t;
  const grp = L.groups.find(G => G.level === (cn.level|0));
  const item = grp && grp.items.find(i => i.cn === cn);
  if (!item) return {...g, point:g.mid, offset:0, slots:1, S:L.S, cols:runCols(cn)};
  const off = item.centreOff;
  return {...g, point:[g.mid[0]+t[0]*off, g.mid[1]+t[1]*off], offset:off,
          slots:grp.items.length, S:L.S, cols:item.cols};
}

/** Which side of the run's direction of travel (a → b) its shorter rows pack
    to: as chosen on the run, or — auto — the side the next manhole lies on,
    and where it lies straight ahead, away from the other runs on the face. */
function runAlign(cn){
  const pref = runAlignPref(cn);
  if (pref !== 'auto') return pref;
  const A = byUid(cn.a.mh), B = byUid(cn.b.mh);
  if (!A || !B) return 'left';
  const g = faceGeom(A, cn.a.face), left = [-g.n[1], g.n[0]];              // left of travel out of A
  const m = (B.x - g.mid[0])*left[0] + (B.y - g.mid[1])*left[1];
  if (Math.abs(m) > g.width/2) return m > 0 ? 'left' : 'right';
  const others = faceRuns(cn.a.mh, cn.a.face).filter(r => r !== cn);
  if (others.length){
    let sum = 0;
    for (const r of others){
      const far = (r.a.mh === cn.a.mh && r.a.face === cn.a.face) ? r.b : r.a, oc = byUid(far.mh);
      if (oc) sum += (oc.x - g.mid[0])*left[0] + (oc.y - g.mid[1])*left[1];
    }
    if (Math.abs(sum) > 1) return sum > 0 ? 'right' : 'left';
  }
  return m >= 0 ? 'left' : 'right';
}
/** The columns each row occupies, as offsets in columns from the run's
    centre, positive to the left of travel: the widest row takes them all, a
    shorter row those on its packed side. */
function rowColumns(cn){
  const rows = runRowsOf(cn), cols = Math.max(...rows), side = runAlign(cn);
  return rows.map(n => Array.from({length:n}, (_, i) => (side === 'left' ? cols - n + i : i) - (cols-1)/2));
}
/** +1 when a face's canonical tangent points to the left of the run's travel
    at this end, −1 when to the right — as the banks lay their lanes. */
function leftSign(cn, end, g, t){
  return end === 'a' ? (Math.sign(t[0]*(-g.n[1]) + t[1]*g.n[0]) || 1)
                     : (Math.sign(t[0]*g.n[1] + t[1]*(-g.n[0])) || 1);
}

/* ==========================================================================
   BANKS
   Runs joining the same pair of faces travel together as one bank: a single
   centreline is routed for the group and every conduit in it is drawn as a
   parallel offset — one road, many lanes, never two different routes.
   ========================================================================== */

const bankCache = new Map();

const endKey = (cn, e) => cn[e].mh + '·' + cn[e].face;
function bankKeyOf(cn){
  const a = endKey(cn,'a'), b = endKey(cn,'b');
  return a < b ? a + '>' + b : b + '>' + a;
}

/** Collect banks with their aggregate constraints and member offsets. */
function buildBanks(){
  const map = new Map();
  for (const cn of state.connections){
    const k = bankKeyOf(cn);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(cn);
  }
  const banks = [];
  for (const [key, members] of map){
    const m0 = members[0];
    const first = endKey(m0,'a') <= endKey(m0,'b') ? 'a' : 'b';
    const start = m0[first], finish = m0[first === 'a' ? 'b' : 'a'];
    const A = byUid(start.mh), B = byUid(finish.mh);
    if (!A || !B) continue;
    const gS = faceGeom(A, start.face), gE = faceGeom(B, finish.face);
    /* canonical face tangents, matching entryFor() */
    const canon = g => {
      let t = norm([g.p2[0]-g.p1[0], g.p2[1]-g.p1[1]]);
      if (t[1] < -1e-9 || (Math.abs(t[1]) <= 1e-9 && t[0] < 0)) t = [-t[0], -t[1]];
      return t;
    };
    const tS = canon(gS), tE = canon(gE);
    const sS = Math.sign(tS[0]*(-gS.n[1]) + tS[1]*gS.n[0]) || 1;          // left of travel out of A
    const sE = Math.sign(tE[0]*gE.n[1] + tE[1]*(-gE.n[0])) || 1;          // left of travel into B
    const ends = members.map(cn => {
      const se = endKey(cn,'a') === endKey(m0,first) ? 'a' : 'b';
      const eS = entryFor(cn, se), eE = entryFor(cn, se === 'a' ? 'b' : 'a');
      const S = Math.max(eS.S || 0, eE.S || 0);
      return {cn, se, oS:eS.offset, oE:eE.offset, S, halfW:(runCols(cn)-1)/2*S};
    });
    const meanS = ends.reduce((a,e) => a+e.oS, 0)/ends.length;
    const meanE = ends.reduce((a,e) => a+e.oE, 0)/ends.length;
    for (const e of ends){ e.w0 = (e.oS-meanS)*sS; e.w1 = (e.oE-meanE)*sE; }
    const maxOff = Math.max(0, ...ends.map(e => Math.max(Math.abs(e.w0), Math.abs(e.w1)) + e.halfW));
    const specs = members.map(specOf);
    let angles = ANGLE_OPTIONS.filter(a => specs.every(sp => sp.angles.includes(a)));
    /* the bank in section: its shallowest lane (zUp below the level-0 datum)
       carries the profile, its deepest row (zDn) sets how much sits beneath */
    const zPitch = Math.max(1, A.zSpace || 0, B.zSpace || 0);
    const zUp = Math.min(...members.map(cn => (cn.level|0) * zPitch));
    const zDn = Math.max(...members.map(cn => (cn.level|0)*zPitch + (runRows(cn) - 1)*runZSpace(cn)));
    const g = {
      key, members, ends, A, B, start, finish,
      PS:[gS.mid[0]+tS[0]*meanS, gS.mid[1]+tS[1]*meanS],
      PE:[gE.mid[0]+tE[0]*meanE, gE.mid[1]+tE[1]*meanE],
      d0:[gS.n[0], gS.n[1]], d2:[-gE.n[0], -gE.n[1]],
      maxOff,
      maxRad: Math.max(...specs.map(sp => sp.radius)),
      enc: Math.max(0, ...members.filter(isEncased).map(cn => encOf(specOf(cn)))),   // an encased bank stands this far beyond its conduits — and is avoided by that box, not a clearance
      maxBuf: Math.max(...specs.map(sp => sp.buffer)),
      levels: new Set(members.map(cn => cn.level|0)),
      zPitch, zUp, zDn,
      anyPlaced: members.some(cn => cn.placed),
      spec: {
        radius: Math.max(...specs.map(sp => sp.radius)),
        bendR: Math.max(...specs.map(sp => sp.bendR)) + maxOff,
        /* offset lanes lose up to maxOff*tan(turn/2) per corner on the inside
           of a bend — budget maxOff onto the straights so every lane still
           carries its own stub and minLeg after offsetting */
        stub: Math.max(...specs.map(sp => sp.stub)) + maxOff,
        minLeg: Math.max(...specs.map(sp => sp.minLeg)) + maxOff,
        buffer: Math.max(...specs.map(sp => sp.buffer)),
        warnAngle: Math.min(...specs.map(sp => sp.warnAngle || 999)),
        angles
      }
    };
    banks.push(g);
  }
  return banks;
}

/** Conduit-to-conduit spacing between two banks: buffers rule, unless they
    share a manhole — then that manhole's lateral spacing governs. */
function bankSpacing(G, H){
  let sPair = G.maxRad + G.enc + H.maxRad + H.enc + Math.max(G.enc ? 0 : G.maxBuf, H.enc ? 0 : H.maxBuf);   // an encasement is the boundary itself
  for (const u of [G.start.mh, G.finish.mh]){
    if (u !== H.start.mh && u !== H.finish.mh) continue;
    const c = byUid(u);
    if (c) sPair = Math.min(sPair, Math.max(G.maxRad + G.enc + H.maxRad + H.enc, c.latSpace - 1));
  }
  return sPair;
}
const levelsMeet = (G, H) => [...G.levels].some(l => H.levels.has(l));

/** Plan keep-outs for a bank: the obstacles its runs go round. One a run
    crosses over or under is no keep-out at all. */
function bankBlockers(G, banks){
  const out = [];
  const pad = G.maxOff + G.maxRad + G.enc;
  for (const o of state.obstacles){
    if (bankMethod(G, o) !== 'around') continue;
    out.push({type:'box', cx:o.x, cy:o.y, rot:o.rot, hw:o.w/2, hh:o.d/2,
              margin: pad + Math.max(G.enc ? 0 : G.maxBuf, o.buffer)});
  }
  for (const c of state.chambers){
    if (c.uid === G.start.mh || c.uid === G.finish.mh) continue;
    if (!(state.avoidChambers || layerMode(c) === 'static')) continue;     // a static model's manholes are kept clear of whatever the setting
    out.push({type:'box', cx:c.x, cy:c.y, rot:c.rot, hw:c.intX/2+c.wall, hh:c.intY/2+c.wall,
              margin: pad + Math.max(G.enc ? 0 : G.maxBuf, c.buffer)});
  }
  for (const H of banks){
    if (H === G || !H.anyPlaced || !H.route || !H.route.ok) continue;
    if (!(state.avoidPipes || H.route.fixed)) continue;         // a static bank is kept clear of whatever the setting
    if (!levelsMeet(G, H)) continue;
      const margin = G.maxOff + H.maxOff + bankSpacing(G, H);
      const shares = u => u === G.start.mh || u === G.finish.mh;
      const free = Math.max(G.spec.stub, H.spec.stub) + margin;
      const line = clipEnds(H.route.poly, shares(H.start.mh) ? free : 0, shares(H.finish.mh) ? free : 0);
      if (!line) continue;
      out.push({type:'line', pts:line, margin, bb:polyBounds(line)});
  }
  return out;
}

function bankSignature(G, banks){
  const box = o => [o.x, o.y, o.w, o.d, o.rot, o.buffer, o.zTop, o.zBot, bankMethod(G, o)];
  const mh  = c => [c.x, c.y, c.intX, c.intY, c.wall, c.rot, c.buffer, c.latSpace, c.zSpace, chamberZ0(c), chamberZs(c), c.win ? Object.values(c.win).map(w => w && w.h) : 0];
  const others = banks
    .filter(H => H !== G && H.anyPlaced && H.route && H.route.ok && (state.avoidPipes || H.route.fixed) && levelsMeet(G, H))
    .map(H => [H.key, H.maxOff, H.maxRad, H.enc, H.maxBuf, H.spec.stub,
               H.route.poly.map(p => [Math.round(p[0]/10), Math.round(p[1]/10)])]);
  return JSON.stringify([G.key, G.PS.map(Math.round), G.PE.map(Math.round), G.ends.map(e => e.cn.fixed ? [e.se, e.cn.fixedPath] : 0),
    G.ends.map(e => [Math.round(e.w0), Math.round(e.w1), Math.round(e.halfW)]), [...G.levels], G.spec, Math.round(G.maxOff), G.enc, G.zUp, G.zDn,
    state.avoidChambers, state.avoidPipes, ROUTE_QUICK, state.ground, state.cover, state.layers.map(l => [l.id, l.mode]),
    state.obstacles.map(box), state.chambers.map(mh), others]);
}

/* ==========================================================================
   THE THIRD DIMENSION
   Every obstacle has a top and a bottom and says how a run may pass it:
   around, over or under. The plan is routed first, going round everything
   it must; only when nothing gets round does it cross the obstacles that
   allow it, crossing as few as it can. The long section is then solved in
   the (chainage, z) plane with the same engine — same fittings, same
   minimum straights, same clearances — stepping under (by default) or over
   each crossed obstacle and keeping its bends off the plan bends.
   ========================================================================== */

/** Distance from a plan point to an obstacle's footprint (0 inside). */
function boxDist(p, o){
  const c = Math.cos(-o.rot*D2R), s = Math.sin(-o.rot*D2R);
  const lx = (p[0]-o.x)*c - (p[1]-o.y)*s, ly = (p[0]-o.x)*s + (p[1]-o.y)*c;
  return Math.hypot(Math.max(0, Math.abs(lx) - o.w/2), Math.max(0, Math.abs(ly) - o.d/2));
}
/** Chainage along a route's tessellated centreline, scaled to its true length. */
function chainage(rt){
  const P = rt.poly, cum = [0];
  for (let i = 1; i < P.length; i++) cum.push(cum[i-1] + Math.hypot(P[i][0]-P[i-1][0], P[i][1]-P[i-1][1]));
  const total = cum[cum.length-1] || 1;
  return {cum, total, k: (rt.length || total)/total};
}
/** Plan point at a chainage along the route. */
function pointAt(rt, s){
  const P = rt.poly, {cum, total, k} = chainage(rt);
  const u = Math.max(0, Math.min(total, s/k));
  let i = 1; while (i < cum.length-1 && cum[i] < u) i++;
  const t = (u - cum[i-1]) / Math.max(1e-9, cum[i]-cum[i-1]);
  return [P[i-1][0] + (P[i][0]-P[i-1][0])*t, P[i-1][1] + (P[i][1]-P[i-1][1])*t];
}
/** Crossable obstacles the bank passes, each with the chainage interval over
    which any lane of the bank sits inside the obstacle's keep-out. */
function routeCrossings(G, rt){
  const P = rt.poly, {cum, k} = chainage(rt), reachBase = G.maxOff + G.maxRad + G.enc;
  const STEP = 25, out = [];
  for (const o of state.obstacles){
    const method = bankMethod(G, o);
    const reach = reachBase + Math.max(G.enc ? 0 : G.maxBuf, o.buffer);
    let s0 = Infinity, s1 = -Infinity;
    for (let i = 0; i < P.length-1; i++){
      const L = cum[i+1]-cum[i], n = Math.max(1, Math.ceil(L/STEP));
      for (let j = 0; j <= n; j++){
        const t = j/n, p = [P[i][0] + (P[i+1][0]-P[i][0])*t, P[i][1] + (P[i+1][1]-P[i][1])*t];
        if (boxDist(p, o) < reach){ const s = cum[i] + L*t; s0 = Math.min(s0, s); s1 = Math.max(s1, s); }
      }
    }
    if (s0 <= s1) out.push({o, method, s0: Math.max(0, (s0-STEP)*k), s1: Math.min(rt.length, (s1+STEP)*k)});
  }
  return out.sort((a,b) => a.s0 - b.s0);
}
/** Chainage bands taken by the plan's own bends, tangent point to tangent point. */
function bendZones(rt){
  const zones = []; let s = 0;
  for (let i = 0; i < rt.turns.length; i++){
    s += rt.clear[i];
    const arc = rt.fillets[i].R*Math.abs(rt.turns[i])*D2R;
    zones.push([s, s + arc]);
    s += arc;
  }
  return zones;
}
function profileZ(pf, s){
  const P = pf.poly;
  for (let i = 0; i < P.length-1; i++)
    if (s >= P[i][0]-1e-6 && s <= P[i+1][0]+1e-6){
      const ds = P[i+1][0]-P[i][0];
      return ds < 1e-6 ? Math.min(P[i][1], P[i+1][1]) : P[i][1] + (P[i+1][1]-P[i][1])*(s-P[i][0])/ds;
    }
  return s <= 0 ? P[0][1] : P[P.length-1][1];
}
function finishProfile(pf, xs, S, zA, zB, lift){
  pf.S = S; pf.zA = pf.pts[0][1]; pf.zB = pf.pts[pf.pts.length-1][1];   // the ends as built, lowered or not
  pf.crossings = xs.map(x => {
    const z = profileZ(pf, (x.s0+x.s1)/2);
    return {uid:x.o.uid, name:x.o.name, s0:x.s0, s1:x.s1, zTop:Math.max(x.o.zTop, x.o.zBot), zBot:Math.min(x.o.zTop, x.o.zBot),
            mode: z >= Math.max(x.o.zTop, x.o.zBot) + lift ? 'over' : 'under', z};
  });
  return pf;
}

/** Chainage bands (±T) taken by a profile's bends, against the plan's. */
function compoundBends(f, zones){
  const hits = [];
  for (let i = 1; i < f.pts.length-1; i++){
    const T = f.fillets[i-1].T, sc = f.pts[i][0];
    zones.forEach((z, j) => { if (sc + T > z[0] - 1 && sc - T < z[1] + 1) hits.push([i, j+1]); });
  }
  return hits;
}
const profileWarn = (f, hits) => {
  for (const [i, j] of hits)
    f.warnings.push({kind:'plan', text:`vertical bend ${i} lands on plan bend ${j} — a compound bend`});
  return f;
};

/** Build one dip (or hump) by construction: a flat at zFlat that covers
    every band, joined to the end levels by diagonals at angle th, placed
    as close to the bands as the straights and the plan's bends allow. */
function buildDip(vs, S, zA, zB, zFlat, bands, th, zones, compound){
  const bs = Math.min(...bands.map(b => b[0])), be = Math.max(...bands.map(b => b[1]));
  const T = vs.bendR*Math.tan(th*D2R/2), tanT = Math.tan(th*D2R), sinT = Math.sin(th*D2R);
  const d1 = zA - zFlat, d2 = zB - zFlat;
  const L1 = Math.abs(d1)/sinT, L2 = Math.abs(d2)/sinT, S1 = Math.abs(d1)/tanT, S2 = Math.abs(d2)/tanT;
  const legMin = vs.minLeg + 2*T;
  if ((Math.abs(d1) > 1 && L1 < legMin) || (Math.abs(d2) > 1 && L2 < legMin)) return null;   // too steep for the drop
  const clearZone = sc => compound || !zones.some(z => sc + T > z[0] - 1 && sc - T < z[1] + 1);
  const STEP = 50;
  let sb1 = null, sb2 = null, sb3 = null, sb4 = null;
  if (Math.abs(d1) > 1){
    for (let c = bs - T; c - S1 >= vs.stub; c -= STEP)
      if (clearZone(c) && clearZone(c - S1)){ sb2 = c; sb1 = c - S1; break; }
    if (sb2 == null) return null;
  }
  if (Math.abs(d2) > 1){
    const flatFrom = sb2 != null ? sb2 : 0;
    for (let c = Math.max(be + T, flatFrom + legMin); c + S2 <= S - vs.stub; c += STEP)
      if (clearZone(c) && clearZone(c + S2)){ sb3 = c; sb4 = c + S2; break; }
    if (sb3 == null) return null;
  } else if (sb2 != null && S - sb2 < legMin) return null;
  if (sb2 == null && sb3 == null) return null;
  const pts = [[0, zA]], turns = [];
  if (sb1 != null){ pts.push([sb1, zA], [sb2, zFlat]); const t = d1 > 0 ? -th : th; turns.push(t, -t); }
  if (sb3 != null){ pts.push([sb3, zFlat], [sb4, zB]); const t = d2 > 0 ? th : -th; turns.push(t, -t); }
  pts.push([S, zB]);
  const segs = []; for (let i = 0; i < pts.length-1; i++) segs.push(Math.hypot(pts[i+1][0]-pts[i][0], pts[i+1][1]-pts[i][1]));
  const f = applyFillets({pts, turns, segs}, vs);
  f.ok = true; f.poly = tessellate(f);
  return f;
}

/** The long section of a bank: from the level-0 datum at one chamber to the
    other, clear over or under every crossed obstacle. An obstacle the
    straight line already clears is left alone. For the rest, a dip under
    and a hump over are each built (where allowed — over never rises into
    the ground cover) and the one with the shorter deviation wins, under on
    a tie. Vertical bends keep off the plan's bends when they can; when they
    cannot, they coincide and the run says so. */
function solveProfile(G, rt, xs){
  const zA = chamberZ0(G.A) - G.zUp, zB = chamberZ0(G.B) - G.zUp, S = rt.length;
  const lift = G.zDn - G.zUp;                       // how far the deepest row hangs below the profile
  if (!xs.length && Math.abs(zB-zA) < 1){
    const pf = {ok:true, pts:[[0,zA],[S,zB]], turns:[], segs:[S], fillets:[], clear:[S], length:S, warnings:[], poly:[[0,zA],[S,zB]]};
    return finishProfile(pf, xs, S, zA, zB, lift);
  }
  const vs = {...G.spec, bendR: G.spec.bendR - G.maxOff + lift,
              stub: G.spec.stub - G.maxOff + lift, minLeg: G.spec.minLeg - G.maxOff + lift};
  const zones = bendZones(rt);
  const ceiling = state.ground - state.cover - G.maxRad - G.enc;      // highest the top lane may run, its encasement under the cover
  const chord = s => zA + (zB-zA)*s/S, chordLen = Math.hypot(S, zB-zA);
  const info = xs.map(x => {
    const top = Math.max(x.o.zTop, x.o.zBot) + lift, bot = Math.min(x.o.zTop, x.o.zBot);
    const margin = G.maxRad + G.enc + Math.max(G.enc ? 0 : G.maxBuf, x.o.buffer);
    const needOver = top + margin + 1, needUnder = bot - margin - 1;     // a hair clear of the keep-out
    const clearOver  = x.method === 'over'  && chord(x.s0) >= needOver  && chord(x.s1) >= needOver;
    const clearUnder = x.method === 'under' && chord(x.s0) <= needUnder && chord(x.s1) <= needUnder;
    return {x, top, bot, margin, needOver, needUnder, free: clearOver || clearUnder,
            canOver: x.method === 'over' && needOver <= ceiling, canUnder: x.method === 'under'};
  });
  const boxes = info.map(i => ({type:'box', cx:(i.x.s0+i.x.s1)/2, cy:(i.bot+i.top)/2, rot:0,
                                hw:Math.max(0, (i.x.s1-i.x.s0)/2 - i.margin), hh:(i.top-i.bot)/2, margin:i.margin}));
  const noBack = f => f.pts.every((p, i) => i === 0 || p[0] >= f.pts[i-1][0] - 1e-6);
  const angles = [...vs.angles].filter(a => a > 0 && a < 180);
  const order = [...angles.filter(a => a <= (vs.warnAngle || 999)).sort((a,b) => b-a),
                 ...angles.filter(a => a > (vs.warnAngle || 999)).sort((a,b) => b-a)];
  const todo = info.filter(i => !i.free);

  /* by construction: one flat under (or over) every crossing that needs it.
     A dip that cannot climb back to the entry level in time may enter the
     chamber lower — down to the conduit window, or just above the base — and
     the run says so. */
  const floorA = entryFloor(G.A, G.start.face, G) + lift, floorB = entryFloor(G.B, G.finish.face, G) + lift;
  const drops = [[0, 0]];
  for (let d = 100; d <= 3000; d += 100) drops.push([0, d]);
  for (let d = 100; d <= 3000; d += 100) drops.push([d, 0]);
  for (let d = 100; d <= 3000; d += 100) drops.push([d, d]);
  const names = todo.map(i => i.x.o.name).join(', ');
  const built = mode => {
    if (!todo.length) return null;
    if (todo.some(i => i.x.method !== mode) || todo.some(i => mode === 'under' ? !i.canUnder : !i.canOver)) return null;
    const bands = todo.map(i => [i.x.s0, i.x.s1]);      // already widened by the clearance in plan
    for (const [dA, dB] of (mode === 'under' ? drops : [[0, 0]])){
      const a = zA - dA, b = zB - dB;
      if (a < floorA || b < floorB) continue;
      const zFlat = mode === 'under' ? Math.min(a, b, ...todo.map(i => i.needUnder))
                                     : Math.max(a, b, ...todo.map(i => i.needOver));
      if (mode === 'over' && zFlat > ceiling) return null;
      for (const compound of [false, true])
        for (const th of order){
          const f = buildDip(vs, S, a, b, zFlat, bands, th, zones, compound);
          if (!f || !noBack(f) || !clearOf(f.poly, boxes)) continue;
          profileWarn(f, compound ? compoundBends(f, zones) : []);
          if (dA) f.warnings.push({kind:'entry', text:`leaves ${G.A.ref} at Z ${fmt(a)}, ${fmt(dA)} below its level, to get under ${names}`});
          if (dB) f.warnings.push({kind:'entry', text:`enters ${G.B.ref} at Z ${fmt(b)}, ${fmt(dB)} below its level, to get under ${names}`});
          return f;
        }
    }
    return null;
  };
  if (todo.length){
    const pick = built('under') || built('over');
    if (pick) return finishProfile(pick, xs, S, zA, zB, lift);
  }

  /* by search: the plan engine in the (chainage, z) plane, first keeping off
     the plan's bends, then allowing compound bends */
  const BIG = 1e7;
  const modesFor = i => i.free ? [null] : (i.canUnder ? ['under'] : i.canOver ? ['over'] : []);
  const combos = info.reduce((acc, i) => acc.flatMap(c => modesFor(i).map(m => [...c, m])), [[]]).slice(0, 8);
  for (const compound of [false, true])
    for (const modes of combos){
      const blockers = info.map((i, k) => {
        const zlo = modes[k] === 'over' ? i.bot - BIG : i.bot, zhi = modes[k] === 'under' ? i.top + BIG : i.top;
        return {type:'box', cx:(i.x.s0+i.x.s1)/2, cy:(zlo+zhi)/2, rot:0,
                hw:Math.max(0, (i.x.s1-i.x.s0)/2 - i.margin), hh:(zhi-zlo)/2, margin:i.margin};
      });
      blockers.accept = f => noBack(f) && (compound || !compoundBends(f, zones).length);
      const pf = solveRoute([0, zA], [1, 0], [S, zB], [1, 0], vs, blockers);
      if (pf.ok) return finishProfile(profileWarn(pf, compound ? compoundBends(pf, zones) : []), xs, S, zA, zB, lift);
    }
  if (!todo.length) return {ok:false, msg:'no way to change level in section'};
  const stuck = todo.filter(i => i.x.method === 'around');
  if (stuck.length) return {ok:false, msg:`route meets ${stuck.map(i => i.x.o.name).join(', ')}, set to around — move it, or choose over or under`};
  const capped = todo.filter(i => i.x.method === 'over' && !i.canOver);
  if (capped.length) return {ok:false, msg:`no way over ${capped.map(i => i.x.o.name).join(', ')} — it would break the ground cover`};
  const unders = todo.filter(i => i.x.method === 'under');
  const deepest = unders.length ? Math.min(...unders.map(i => i.needUnder)) : Infinity;
  const tooDeep = deepest < floorA || deepest < floorB;
  const how = todo.every(i => i.x.method === 'under') ? 'under' : todo.every(i => i.x.method === 'over') ? 'over' : 'past';
  return {ok:false, msg:`no way ${how} ${names} in section` +
    (tooDeep ? ` — no room to climb back, and entering ${deepest < floorB ? G.B.ref : G.A.ref} that low would be below its ${entryFloorKind(deepest < floorB ? G.B : G.A, deepest < floorB ? G.finish.face : G.start.face)}` : '')};
}
/** Lowest a conduit centreline may enter a chamber face: the bottom of the
    family's conduit window where there is one, else just above the base. */
function entryFloor(c, face, G){
  const win = c.win && c.win[face];
  if (win && win.h) return chamberZ0(c) + 150 - win.h + G.maxRad;
  return chamberZs(c)[0] + G.maxRad + 100;
}
const entryFloorKind = (c, face) => c.win && c.win[face] && c.win[face].h ? 'conduit window' : 'base';
function reversedProfile(pf){
  const S = pf.S, flip = p => [S - p[0], p[1]];
  return {...pf, pts:[...pf.pts].reverse().map(flip), segs:[...pf.segs].reverse(),
    turns:[...pf.turns].reverse(), fillets:[...pf.fillets].reverse(), clear:[...pf.clear].reverse(),
    poly:[...pf.poly].reverse().map(flip), zA:pf.zB, zB:pf.zA,
    crossings: pf.crossings.map(x => ({...x, s0:S - x.s1, s1:S - x.s0})).reverse()};
}
function memberProfile(pf, shift){
  const dz = p => [p[0], p[1] - shift];
  return {...pf, pts:pf.pts.map(dz), poly:pf.poly.map(dz), zA:pf.zA - shift, zB:pf.zB - shift,
          crossings: pf.crossings.map(x => ({...x, z: x.z - shift}))};
}

/** A run placed as its model has it: the modelled centreline read as plan
    vertices with the section along it. It is never re-routed, carries no
    fittings of the tool's own, and other runs keep clear of it. */
function fixedRoute(path){
  const pts = [], zs = [];
  for (const q of path){
    if (pts.length && Math.hypot(q[0]-pts[pts.length-1][0], q[1]-pts[pts.length-1][1]) < 1) continue;
    pts.push([q[0], q[1]]); zs.push(q[2] || 0);
  }
  if (pts.length < 2){ const q = path[path.length-1]; pts.push([q[0] + 1, q[1]]); zs.push(q[2] || 0); }
  const segs = [], turns = [];
  for (let i = 0; i < pts.length-1; i++) segs.push(Math.hypot(pts[i+1][0]-pts[i][0], pts[i+1][1]-pts[i][1]));
  for (let i = 1; i < pts.length-1; i++)
    turns.push(signedAngle(norm([pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]]), norm([pts[i+1][0]-pts[i][0], pts[i+1][1]-pts[i][1]])));
  const fillets = turns.map(t => ({R:0, T:0, deflect:Math.abs(t), cut:false}));
  const length = segs.reduce((a, b) => a + b, 0);
  const cum = [0]; for (const L of segs) cum.push(cum[cum.length-1] + L);
  let len3 = 0; for (let i = 1; i < pts.length; i++) len3 += Math.hypot(segs[i-1], zs[i]-zs[i-1]);
  const ppoly = cum.map((s, i) => [s, zs[i]]);
  const profile = {S:length, pts:ppoly, segs:[], turns:[], fillets:[], clear:[], poly:ppoly, zA:zs[0], zB:zs[zs.length-1], crossings:[], length:len3, warnings:[]};
  return {ok:true, fixed:true, pts, turns, segs, fillets, clear:segs.slice(), length, warnings:[], poly:pts.map(p => p.slice()), profile, crossings:[], length3d:len3};
}
/** The bank's route when a member came in static: its modelled centreline, run the bank's way round. */
function fixedBankRoute(G){
  const e = G.ends.find(e => e.cn.fixed && Array.isArray(e.cn.fixedPath) && e.cn.fixedPath.length >= 2);
  if (!e) return null;
  return fixedRoute(e.se === 'a' ? e.cn.fixedPath : [...e.cn.fixedPath].reverse());
}

/** Plan first, round every obstacle its runs go round; then the section,
    crossing the rest as chosen. */
function solveBank(G, banks){
  const rt = solveRoute(G.PS, G.d0, G.PE, G.d2, G.spec, bankBlockers(G, banks), {plan:true});
  if (!rt.ok){
    if (/blocked/.test(rt.msg || '') && state.obstacles.some(o => bankMethod(G, o) === 'around'))
      return {ok:false, msg:'blocked — no way round; choose over or under for an obstacle in the run\'s Obstacles list'};
    return rt;
  }
  const pf = solveProfile(G, rt, routeCrossings(G, rt));
  if (!pf.ok) return {ok:false, msg:pf.msg};
  rt.profile = pf;
  rt.crossings = pf.crossings;
  return rt;
}

/** A member's route is the bank centreline shifted sideways, its offset
    easing from the entry slot at one manhole to the slot at the other. */
function offsetMember(rt, w0, w1){
  const pts = rt.pts, n = pts.length;
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i-1] + Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]));
  const total = Math.max(1e-9, cum[n-1]);
  const wAt = i => w0 + (w1-w0)*cum[i]/total;
  const dir = i => norm([pts[i+1][0]-pts[i][0], pts[i+1][1]-pts[i][1]]);
  const left = u => [-u[1], u[0]];
  const np = [];
  for (let i = 0; i < n; i++){
    const w = wAt(i);
    if (i === 0 || i === n-1){
      const L = left(dir(i === 0 ? 0 : n-2));
      np.push([pts[i][0]+L[0]*w, pts[i][1]+L[1]*w]);
    } else {
      const lu = left(dir(i-1)), lv = left(dir(i));
      const m = norm([lu[0]+lv[0], lu[1]+lv[1]]);
      const cosHalf = Math.max(0.25, m[0]*lu[0]+m[1]*lu[1]);
      np.push([pts[i][0]+m[0]*w/cosHalf, pts[i][1]+m[1]*w/cosHalf]);
    }
  }
  const segs = [];
  for (let i = 0; i < n-1; i++) segs.push(Math.hypot(np[i+1][0]-np[i][0], np[i+1][1]-np[i][1]));
  const fillets = rt.fillets.map((f, i) => {
    const R = Math.max(1, f.R - wAt(i+1)*Math.sign(rt.turns[i] || 1));
    let T = R*Math.tan(Math.abs(rt.turns[i])*D2R/2);
    const cap = Math.min(segs[i]*(i > 0 ? 0.5 : 1), segs[i+1]*(i < rt.turns.length-1 ? 0.5 : 1));
    if (T > cap){ T = cap; }
    return {...f, R: T/Math.max(1e-9, Math.tan(Math.abs(rt.turns[i])*D2R/2)), T};
  });
  let length = segs.reduce((a,b) => a+b, 0);
  fillets.forEach((f, i) => { length += f.R*Math.abs(rt.turns[i])*D2R - 2*f.T; });
  const clear = segs.map((L,i) => L - (i > 0 ? fillets[i-1].T : 0) - (i < segs.length-1 ? fillets[i].T : 0));
  const out = {ok:true, pts:np, turns:[...rt.turns], segs, fillets, clear, length, warnings:[]};
  out.poly = tessellate(out);
  return out;
}

function reversedRoute(r){
  return {...r,
    pts:[...r.pts].reverse(), segs:[...r.segs].reverse(),
    turns:[...r.turns].reverse().map(t => -t),
    fillets:[...r.fillets].reverse(), clear:[...r.clear].reverse(),
    poly:[...r.poly].reverse()};
}

function deriveMembers(G){
  for (const e of G.ends){
    const cn = e.cn, sp = specOf(cn);
    if (!G.route || !G.route.ok){ cn.route = {ok:false, msg:G.route ? G.route.msg : 'no route'}; continue; }
    let r = offsetMember(G.route, e.w0, e.w1);
    if (e.se !== 'a') r = reversedRoute(r);
    r.fixed = !!G.route.fixed;
    r.warnings = G.route.warnings.filter(w => w.kind === 'radius').map(w => ({...w}));
    if (!r.fixed) r.turns.forEach((t, i) => {
      if (sp.warnAngle && Math.abs(t) > sp.warnAngle + 1e-6)
        r.warnings.push({kind:'angle', bend:i+1,
          text:`bend ${i+1} — ${fmt1(Math.abs(t))}° is over the ${fmt1(sp.warnAngle)}° limit`});
      if (isCustomTurn(t, sp.angles))
        r.warnings.push({kind:'custom', bend:i+1,
          text:`bend ${i+1} — ${fmt1(Math.abs(t))}° is a custom fitting, made to suit the angle between these faces`});
    });
    /* the section: the bank profile dropped to this member's level */
    let pf = G.route.profile ? memberProfile(G.route.profile, (cn.level|0)*G.zPitch - G.zUp) : null;
    if (pf && e.se !== 'a') pf = reversedProfile(pf);
    r.profile = pf;
    r.crossings = pf ? pf.crossings : [];
    r.leadLane = e === G.ends[0];        // the lane that carries the bank's crossing labels
    for (const o of state.obstacles){
      const want = runMethod(cn, o), got = bankMethod(G, o);
      if (want !== got) r.warnings.push({kind:'method', text:`${o.name} — this run asks for ${want}, but the bank it shares these faces with goes ${got}`});
    }
    r.length3d = pf ? r.length + (pf.length - pf.S) : r.length;
    if (pf) for (const w of pf.warnings) r.warnings.push({kind:'v' + w.kind, text:`in section, ${w.text}`});
    cn.route = r;
  }
}

function recomputeRoutes(){
  let banks = null;
  for (let pass = 0; pass < 3; pass++){
    banks = buildBanks();
    let changed = false;
    for (const G of banks){
      const cached = bankCache.get(G.key);
      if (cached) G.route = cached.route;
      const sig = bankSignature(G, banks);
      if (cached && cached.sig === sig && cached.route) continue;
      G.route = fixedBankRoute(G) || solveBank(G, banks);
      bankCache.set(G.key, {sig, route:G.route});
      changed = true;
    }
    for (const G of banks) deriveMembers(G);
    if (!changed) break;
  }
  for (const k of [...bankCache.keys()])
    if (!banks.some(G => G.key === k)) bankCache.delete(k);

  /* every face must be wide enough for its conduit grid plus edge clearance */
  const faceKeys = new Set();
  for (const c of state.connections) for (const end of ['a','b'])
    faceKeys.add(c[end].mh + '|' + c[end].face);
  for (const k of faceKeys){
    const [mhU, face] = k.split('|');
    const L = faceLayout(mhU, face);
    if (!L || L.fits) continue;
    const need = L.usedW + 2*(L.c.edgeClear || 0);
    for (const r of faceRuns(mhU, face)) if (r.route && r.route.ok)
      r.route.warnings.push({kind:'face',
        text:`face ${L.c.ref}·${face} — grid needs ${fmt(need)} across a ${fmt(L.g.width)} face (pitch ${fmt(L.S)}, edge ${fmt(L.c.edgeClear||0)})`});
  }

  /* residual bank-to-bank separation check */
  if (!banks) return;
  const live = banks.filter(G => G.anyPlaced && G.route && G.route.ok);
  for (let i = 0; i < live.length; i++) for (let j = i+1; j < live.length; j++){
    const G = live[i], H = live[j];
    if (G.route.fixed && H.route.fixed) continue;                   // two static banks sit as modelled
    if (!(state.avoidPipes || G.route.fixed || H.route.fixed)) continue;
    if (!levelsMeet(G, H)) continue;
    const margin = G.maxOff + H.maxOff + bankSpacing(G, H);
    const free = Math.max(G.spec.stub, H.spec.stub) + margin;
    const sh = (X, Y) => u => u === Y.start.mh || u === Y.finish.mh ? free : 0;
    const pg = clipEnds(G.route.poly, sh(G,H)(G.start.mh), sh(G,H)(G.finish.mh));
    const ph = clipEnds(H.route.poly, sh(H,G)(H.start.mh), sh(H,G)(H.finish.mh));
    if (!pg || !ph) continue;
    if (lineLineDist(pg, ph, margin) < margin - 1)
      for (const bank of [G, H]) for (const cn of bank.members)
        if (cn.route && cn.route.ok)
          cn.route.warnings.push({kind:'clash',
            text:`buffer to ${connLabel(bank === G ? H.members[0] : G.members[0])} not met`});
  }
}

/* ==========================================================================
   VIEW
   ========================================================================== */

const W2S = p => [state.view.tx + p[0]*state.view.s, state.view.ty - p[1]*state.view.s];
const S2W = p => [(p[0]-state.view.tx)/state.view.s, (state.view.ty-p[1])/state.view.s];

function fitView(pad = 90){
  const r = STAGE.getBoundingClientRect();
  if (!state.chambers.length && !state.obstacles.length){
    state.view = {tx:r.width/2, ty:r.height/2, s:0.05}; return draw();
  }
  let minx=1e12, miny=1e12, maxx=-1e12, maxy=-1e12;
  const eat = p => { minx=Math.min(minx,p[0]); maxx=Math.max(maxx,p[0]);
                     miny=Math.min(miny,p[1]); maxy=Math.max(maxy,p[1]); };
  for (const c of state.chambers) corners(c, c.wall).forEach(eat);
  for (const o of state.obstacles) boxCorners(o, 0).forEach(eat);
  for (const cn of state.connections) if (cn.route && cn.route.ok) cn.route.pts.forEach(eat);
  const s = Math.min((r.width-pad*2)/Math.max(maxx-minx,1), (r.height-pad*2)/Math.max(maxy-miny,1));
  state.view.s = Math.max(0.0005, Math.min(3, s));
  state.view.tx = r.width/2  - (minx+maxx)/2*state.view.s;
  state.view.ty = r.height/2 + (miny+maxy)/2*state.view.s;
  draw();
}

/* ==========================================================================
   DRAW
   ========================================================================== */

const esc  = s => String(s).replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
const pts  = arr => arr.map(p => { const q = W2S(p); return q[0].toFixed(1)+','+q[1].toFixed(1); }).join(' ');
const fmt  = v => Math.round(v).toLocaleString('en-GB');
const fmt1 = v => (Math.round(v*10)/10).toString();
const metres = v => (v/1000).toFixed(2) + ' m';
const poly  = arr => `M${pts(arr).replace(/ /g,' L')} Z`;

function gridStep(scale = state.view.s){
  const steps = [50,100,250,500,1000,2500,5000,10000,25000,50000,100000];
  for (const st of steps) if (st*scale >= 55) return st;
  return steps[steps.length-1];
}
function routePathScreen(rt){
  const P = rt.pts.map(W2S), s = state.view.s;
  if (P.length < 2) return '';
  let d = `M${P[0][0].toFixed(1)},${P[0][1].toFixed(1)}`;
  for (let i = 1; i < P.length-1; i++){
    const f = rt.fillets[i-1], cur = P[i], prev = P[i-1], nxt = P[i+1];
    const Ts = f.T*s, Rs = f.R*s;
    if (Ts < 0.4 || Rs < 0.4){ d += ` L${cur[0].toFixed(1)},${cur[1].toFixed(1)}`; continue; }
    const u = norm([prev[0]-cur[0], prev[1]-cur[1]]), v = norm([nxt[0]-cur[0], nxt[1]-cur[1]]);
    const a1 = [cur[0]+u[0]*Ts, cur[1]+u[1]*Ts], a2 = [cur[0]+v[0]*Ts, cur[1]+v[1]*Ts];
    const cross = (cur[0]-prev[0])*(nxt[1]-cur[1]) - (cur[1]-prev[1])*(nxt[0]-cur[0]);
    d += ` L${a1[0].toFixed(1)},${a1[1].toFixed(1)}`
       + ` A${Rs.toFixed(2)},${Rs.toFixed(2)} 0 0 ${cross > 0 ? 1 : 0} ${a2[0].toFixed(1)},${a2[1].toFixed(1)}`;
  }
  const last = P[P.length-1];
  return d + ` L${last[0].toFixed(1)},${last[1].toFixed(1)}`;
}

function draw(){
  recomputeRoutes();
  if (state.view3d) draw3d();          // the 3D window follows every change
  const r = STAGE.getBoundingClientRect();
  const W = r.width, H = r.height, s = state.view.s;
  const out = [];
  const hs = Math.max(3.5, Math.min(15, 63*s + 3));

  out.push(`<defs>
    <pattern id="hatch" patternUnits="userSpaceOnUse" width="${hs}" height="${hs}" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="${hs}" stroke="${C.wall}" stroke-width="1"/></pattern>
    <pattern id="obs" patternUnits="userSpaceOnUse" width="${hs*1.6}" height="${hs*1.6}" patternTransform="rotate(-45)">
      <line x1="0" y1="0" x2="0" y2="${hs*1.6}" stroke="${C.obsHatch}" stroke-width="1.4"/></pattern>
  </defs>`);

  if (state.showGrid){
    const st = gridStep();
    const [x0,y1] = S2W([0,0]), [x1,y0] = S2W([W,H]);
    for (let x = Math.ceil(x0/st)*st; x <= x1; x += st){
      const sx = W2S([x,0])[0], major = Math.abs(Math.round(x/st)) % 5 === 0;
      out.push(`<line x1="${sx.toFixed(1)}" y1="0" x2="${sx.toFixed(1)}" y2="${H}" stroke="${major?C.gridMajor:C.gridMinor}" stroke-width="1"/>`);
    }
    for (let y = Math.ceil(y0/st)*st; y <= y1; y += st){
      const sy = W2S([0,y])[1], major = Math.abs(Math.round(y/st)) % 5 === 0;
      out.push(`<line x1="0" y1="${sy.toFixed(1)}" x2="${W}" y2="${sy.toFixed(1)}" stroke="${major?C.gridMajor:C.gridMinor}" stroke-width="1"/>`);
    }
    const o = W2S([0,0]);
    out.push(`<line x1="0" y1="${o[1]}" x2="${W}" y2="${o[1]}" stroke="${C.axisX}" stroke-width="1"/>`);
    out.push(`<line x1="${o[0]}" y1="0" x2="${o[0]}" y2="${H}" stroke="${C.axisY}" stroke-width="1"/>`);
  }

  for (const o of state.obstacles) if (isVisible(o)) out.push(drawObstacle(o));
  for (const cn of state.connections) if (isVisible(cn)) out.push(drawConnection(cn));

  for (const c of state.chambers){
    if (!isVisible(c)) continue;
    const inner = corners(c, 0), outer = corners(c, c.wall);
    const on = inSel('chamber', c.uid);
    const stroke = on ? C.sel : C.ink, ext = c.intX + 2*c.wall;
    if (c.lid)
      out.push(`<polygon points="${pts([[c.lid.x[0],c.lid.y[0]],[c.lid.x[1],c.lid.y[0]],[c.lid.x[1],c.lid.y[1]],[c.lid.x[0],c.lid.y[1]]].map(p => toWorld(c, p)))}" fill="none" stroke="${C.inkFaint}" stroke-width="1" stroke-dasharray="4 3" opacity=".7"/>`);
    if (c.buffer > 0)
      out.push(`<polygon points="${pts(corners(c, c.wall + c.buffer))}" fill="none" stroke="${C.inkFaint}" stroke-width="1" stroke-dasharray="5 4" opacity=".55"/>`);
    out.push(`<polygon points="${pts(inner)}" fill="${C.chamber}"/>`);
    out.push(`<path d="${poly(outer)} ${poly(inner)}" fill="url(#hatch)" fill-rule="evenodd" opacity=".85"/>`);
    out.push(`<polygon points="${pts(outer)}" fill="none" stroke="${stroke}" stroke-width="${on?2:1.4}"/>`);
    out.push(`<polygon points="${pts(inner)}" fill="none" stroke="${stroke}" stroke-width="${on?1.6:1.1}" opacity=".9"/>`);
    const ctr = W2S([c.x, c.y]);
    if (ext*s > 34){
      out.push(`<line x1="${ctr[0]-5}" y1="${ctr[1]}" x2="${ctr[0]+5}" y2="${ctr[1]}" stroke="${stroke}" stroke-width="1" opacity=".5"/>`);
      out.push(`<line x1="${ctr[0]}" y1="${ctr[1]-5}" x2="${ctr[0]}" y2="${ctr[1]+5}" stroke="${stroke}" stroke-width="1" opacity=".5"/>`);
    }
    if (ext*s > 46){
      for (const f of FACES){
        const g = faceGeom(c, f), m = W2S(g.mid), un = norm([g.n[0], -g.n[1]]);
        out.push(`<text x="${m[0]-un[0]*11}" y="${m[1]-un[1]*11+3.4}" fill="${C.inkFaint}" font-family="${C.mono}" font-size="9.5" text-anchor="middle">${f}</text>`);
      }
      out.push(`<text x="${ctr[0]}" y="${ctr[1]-6}" fill="${stroke}" font-family="${C.mono}" font-size="12" text-anchor="middle" letter-spacing="1">${esc(c.ref)}</text>`);
      if (state.showDims && ext*s > 96)
        out.push(`<text x="${ctr[0]}" y="${ctr[1]+11}" fill="${C.inkDim}" font-family="${C.mono}" font-size="10" text-anchor="middle">${fmt(c.intX)}×${fmt(c.intY)}  w${fmt(c.wall)}</text>`);
    }
  }

  if (state.pending){
    const c = byUid(state.pending.mh);
    if (c) out.push(faceMarker(faceGeom(c, state.pending.face), C.sel));
  }
  if (state.hoverFace){
    const c = byUid(state.hoverFace.mh);
    if (c) out.push(faceMarker(faceGeom(c, state.hoverFace.face), C.pick));
  }
  if (state.rubber){
    const b = state.rubber, crossing = b.x1 < b.x0;
    out.push(`<rect x="${Math.min(b.x0, b.x1)}" y="${Math.min(b.y0, b.y1)}" width="${Math.abs(b.x1-b.x0)}" height="${Math.abs(b.y1-b.y0)}"
      fill="${crossing ? 'rgba(107,214,138,.10)' : 'rgba(53,195,232,.10)'}" stroke="${crossing ? '#6bd68a' : C.pick}" stroke-width="1"${crossing ? ' stroke-dasharray="5 4"' : ''}/>`);
  }

  SVG.setAttribute('viewBox', `0 0 ${W} ${H}`);
  SVG.innerHTML = out.join('');
  drawScaleBar();
  document.getElementById('rz').textContent = (state.view.s*100).toFixed(1) + ' px/cm';
}

function drawObstacle(o){
  const on = inSel('obstacle', o.uid);
  const s = state.view.s, body = boxCorners(o, 0), clr = boxCorners(o, o.buffer);
  const stroke = on ? C.sel : C.obsLine;
  const out = [];
  if (o.buffer > 0)
    out.push(`<polygon points="${pts(clr)}" fill="none" stroke="${C.obsHatch}" stroke-width="1" stroke-dasharray="5 4" opacity=".85"/>`);
  out.push(`<polygon points="${pts(body)}" fill="${C.obsFill}"/>`);
  out.push(`<polygon points="${pts(body)}" fill="url(#obs)" opacity=".8"/>`);
  out.push(`<polygon points="${pts(body)}" fill="none" stroke="${stroke}" stroke-width="${on?2:1.3}"/>`);
  if (Math.min(o.w,o.d)*s > 44){
    const ctr = W2S([o.x, o.y]);
    out.push(`<text x="${ctr[0]}" y="${ctr[1]+4}" fill="${stroke}" font-family="${C.mono}" font-size="11" text-anchor="middle">${esc(o.name)}</text>`);
    if (state.showDims && Math.min(o.w,o.d)*s > 76)
      out.push(`<text x="${ctr[0]}" y="${ctr[1]+17}" fill="${C.inkDim}" font-family="${C.mono}" font-size="9.5" text-anchor="middle">${obsMethod(o)}</text>`);
  }
  return out.join('');
}

function drawConnection(cn){
  const A = byUid(cn.a.mh), B = byUid(cn.b.mh);
  if (!A || !B) return '';
  const s = state.view.s, sp = specOf(cn), rt = cn.route;
  const on = inSel('conn', cn.uid);
  const ea = entryFor(cn,'a'), eb = entryFor(cn,'b');
  const p = W2S(ea.point), q = W2S(eb.point);
  const out = [];

  if (!cn.placed || !rt || !rt.ok){
    const col = rt && !rt.ok ? C.bad : (on ? C.sel : C.ghost);
    if (rt && rt.ok && on)
      out.push(`<path d="${routePathScreen(rt)}" fill="none" stroke="${sp.colour}" stroke-width="${Math.max(1, 2*sp.radius*s)}" stroke-linejoin="round" opacity=".22"/>`);
    out.push(`<line x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}" stroke="${col}" stroke-width="${on?1.8:1.2}" stroke-dasharray="6 5" opacity=".85"/>`);
    out.push(`<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="${col}"/><circle cx="${q[0]}" cy="${q[1]}" r="3" fill="${col}"/>`);
    if (rt && !rt.ok){
      const mx = (p[0]+q[0])/2, my = (p[1]+q[1])/2;
      out.push(`<text x="${mx}" y="${my-7}" fill="${C.bad}" font-family="${C.mono}" font-size="10.5" text-anchor="middle">${esc(rt.msg)}</text>`);
    }
    return out.join('');
  }

  const body = Math.max(1.5, 2*sp.radius*s);
  const edge = on ? C.sel : sp.colour;
  const cols = runCols(cn), S = Math.max(entryFor(cn,'a').S || 0, entryFor(cn,'b').S || 0);
  const halfW = (cols-1)/2*S;
  /* one polyline per column of the array, offset off the routed centreline */
  const lanes = [];
  for (let k = 0; k < cols; k++){
    const w = (k - (cols-1)/2) * S;
    let lane = rt;
    if (Math.abs(w) > 1e-6){ try { lane = offsetMember(rt, w, w); } catch(_){ lane = rt; } }
    lanes.push(routePathScreen(lane));
  }
  const d = lanes[Math.floor(cols/2)] || lanes[0];
  const E = showEnc(cn) ? runEncasement(cn) : null;
  if (E){
    const edges = [];
    for (const w of [E.halfW, -E.halfW]){ try { edges.push(routePathScreen(offsetMember(rt, w, w))); } catch(_){} }
    out.push(`<path d="${routePathScreen(rt)}" fill="none" stroke="${sp.colour}" stroke-width="${(E.W*s).toFixed(1)}" stroke-linejoin="round" stroke-linecap="butt" opacity=".11"/>`);
    for (const ed of edges) out.push(`<path d="${ed}" fill="none" stroke="${edge}" stroke-width="1" stroke-dasharray="5 3" opacity=".6"/>`);
  }
  if (on && sp.buffer > 0)
    out.push(`<path d="${lanes[Math.floor(cols/2)]}" fill="none" stroke="${sp.colour}" stroke-width="${2*(halfW+sp.radius+sp.buffer)*s}" stroke-linejoin="round" stroke-linecap="round" opacity=".09"/>`);
  for (const ld of lanes){
    out.push(`<path d="${ld}" fill="none" stroke="${edge}" stroke-width="${body}" stroke-linejoin="round" stroke-linecap="butt" opacity=".95"/>`);
    if (body > 4) out.push(`<path d="${ld}" fill="none" stroke="${C.pipeBody}" stroke-width="${body-2.4}" stroke-linejoin="round" stroke-linecap="butt"/>`);
  }
  out.push(`<path d="${d}" fill="none" stroke="${edge}" stroke-width="1" stroke-dasharray="${rt.fixed ? '2 4' : '9 4 2 4'}" opacity=".8"/>`);
  out.push(`<circle cx="${p[0]}" cy="${p[1]}" r="3.2" fill="${edge}"/><circle cx="${q[0]}" cy="${q[1]}" r="3.2" fill="${edge}"/>`);

  const flagged = new Set(rt.warnings.map(w => w.bend));
  if (!rt.fixed) rt.fillets.forEach((f,i) => {
    const v = W2S(rt.pts[i+1]);
    if (flagged.has(i+1)){
      out.push(`<circle cx="${v[0]}" cy="${v[1]}" r="9" fill="none" stroke="${C.warn}" stroke-width="1.6"/>`);
      out.push(`<text x="${v[0]+12}" y="${v[1]-8}" fill="${C.warn}" font-family="${C.mono}" font-size="10.5">${fmt1(f.deflect)}°</text>`);
    } else if (state.showDims && body > 5){
      out.push(`<text x="${v[0]+7}" y="${v[1]-6}" fill="${C.inkDim}" font-family="${C.mono}" font-size="10">${fmt1(f.deflect)}°</text>`);
    }
  });
  if (state.showDims && rt.length*s > 80){
    const m = W2S(pointAt(rt, rt.length/2));
    const lvl = (cn.level|0) ? ' · L' + (cn.level|0) : '';
    out.push(`<text x="${m[0]}" y="${m[1]-body/2-7}" fill="${edge}" font-family="${C.mono}" font-size="10.5" text-anchor="middle">${metres(rt.length3d || rt.length)}${lvl}${rt.fixed ? ' · static' : ''}</text>`);
  }
  if (state.showDims && rt.leadLane && rt.crossings && rt.crossings.length)
    for (const x of rt.crossings){
      const m = W2S(pointAt(rt, x.s0));
      out.push(`<text x="${m[0]}" y="${m[1]+body/2+13}" fill="${edge}" font-family="${C.mono}" font-size="10" text-anchor="middle">${x.mode === 'under' ? '▼ under' : '▲ over'} ${esc(x.name)}</text>`);
    }
  return out.join('');
}

function faceMarker(f, colour){
  const a = W2S(f.p1), b = W2S(f.p2), m = W2S(f.mid), u = norm([f.n[0], -f.n[1]]);
  return `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${colour}" stroke-width="3.4" stroke-linecap="round"/>`
       + `<line x1="${a[0]-u[0]*6}" y1="${a[1]-u[1]*6}" x2="${a[0]+u[0]*6}" y2="${a[1]+u[1]*6}" stroke="${colour}" stroke-width="1.4"/>`
       + `<line x1="${b[0]-u[0]*6}" y1="${b[1]-u[1]*6}" x2="${b[0]+u[0]*6}" y2="${b[1]+u[1]*6}" stroke="${colour}" stroke-width="1.4"/>`
       + `<circle cx="${m[0]}" cy="${m[1]}" r="3.2" fill="${colour}"/>`;
}
function drawScaleBar(scale = state.view.s){
  const el = document.getElementById('scalebar');
  const opts = [100,200,500,1000,2000,5000,10000,20000,50000,100000];
  let pick = opts[0];
  for (const o of opts){ pick = o; if (o*scale >= 70) break; }
  el.querySelector('.bar').style.width = (pick*scale) + 'px';
  el.querySelector('span').textContent = pick >= 1000 ? (pick/1000)+' m' : pick+' mm';
}

/* ==========================================================================
   3D VIEW
   An orthographic look at the whole drawing: chambers and obstacles as boxes
   between their top and bottom levels, every conduit at its true depth along
   its route, over the ground grid at Z 0. Drag to orbit, shift-drag to pan,
   scroll to zoom, click to select. Faces and conduit segments are painted
   far to near, so a run passing under an obstacle disappears beneath it and
   one passing over rides on top.
   ========================================================================== */

let stageW = 0, stageH = 0, prims3d = [], drag3 = null;
const SVG3 = document.getElementById('svg3d'), V3BODY = document.getElementById('v3body');
const v3Rect = () => V3BODY.getBoundingClientRect();

/** World [x,y,z] → screen [sx, sy, nearness] under the orbit camera. */
function proj(p){
  const cam = state.cam, a = cam.az*D2R, e = cam.el*D2R;
  const x = p[0]-cam.cx, y = p[1]-cam.cy, z = (p[2]||0)-cam.cz;
  const X = x*Math.cos(a) + y*Math.sin(a), U = -x*Math.sin(a) + y*Math.cos(a);
  const up = z*Math.cos(e) + U*Math.sin(e), near = z*Math.sin(e) - U*Math.cos(e);
  return [stageW/2 + cam.px + X*cam.s, stageH/2 + cam.py - up*cam.s, near];
}

/** The 3D centreline(s) of a run: plan route with the section's depth at
    every chainage of either — one polyline per column and row of the array. */
/** One line of a run in 3D: the plan centreline offset sideways by w (mm, left of travel), the section's depth at every chainage, shifted by dz. */
function lane3d(cn, w, dz = 0){
  const rt = cn.route, pf = rt.profile, A = byUid(cn.a.mh), B = byUid(cn.b.mh);
  const zPitch = Math.max(1, A ? A.zSpace : 0, B ? B.zSpace : 0);
  const zFlat = chamberZ0(A) - (cn.level|0)*zPitch;
  let lane = rt;
  if (Math.abs(w) > 1e-6){ try { lane = offsetMember(rt, w, w); } catch(_){ lane = rt; } }
  const {cum, k:kk} = chainage(lane), L = lane.length || 1, PS = pf ? (pf.S || L) : L;
  const ss = cum.map(v => v*kk);
  if (pf) for (const q of pf.poly) ss.push(q[0]*L/PS);
  const sorted = [...new Set(ss.map(v => Math.round(v*10)/10))].filter(v => v >= 0 && v <= L + 1e-6).sort((a,b) => a-b);
  return sorted.map(v => { const q = pointAt(lane, v); return [q[0], q[1], (pf ? profileZ(pf, v*PS/L) : zFlat) + dz]; });
}
function run3d(cn){
  const rt = cn.route, out = [];
  if (!rt || !rt.ok) return out;
  const S = Math.max(entryFor(cn,'a').S || 0, entryFor(cn,'b').S || 0);
  const zPitch = runZSpace(cn);
  const RC = rowColumns(cn), lines = new Map();
  const lineAt = off => {                       // one centreline per column, shared by the rows that use it
    if (!lines.has(off)) lines.set(off, lane3d(cn, off * S));
    return lines.get(off);
  };
  for (let rI = 0; rI < RC.length; rI++) for (const off of RC[rI]){
    const line = lineAt(off);
    out.push(rI ? line.map(q => [q[0], q[1], q[2] - rI*zPitch]) : line);
  }
  return out;
}

/** The four long edges of a run's encasement box in 3D, or none without an encasement. */
function encasement3d(cn){
  const rt = cn.route, E = rt && rt.ok && showEnc(cn) ? runEncasement(cn) : null;
  if (!E) return [];
  return [lane3d(cn, E.halfW, E.zTop), lane3d(cn, -E.halfW, E.zTop), lane3d(cn, E.halfW, E.zBot), lane3d(cn, -E.halfW, E.zBot)];
}

function drawingExtent(){
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const eat = p => { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); };
  for (const c of state.chambers) corners(c, c.wall).forEach(eat);
  for (const o of state.obstacles) boxCorners(o, 0).forEach(eat);
  for (const cn of state.connections) if (cn.route && cn.route.ok) cn.route.pts.forEach(eat);
  return x0 <= x1 ? [x0, y0, x1, y1] : null;
}

/** Fit the camera to everything drawn, keeping the current orbit angles. */
function fit3d(pad = 70){
  if (!state.view3d) return;
  const r = v3Rect(); stageW = r.width; stageH = r.height;
  if (!(r.width > 0 && r.height > 0)) return;
  const cam = state.cam, pts = [];
  for (const c of state.chambers){ const [zb, zl] = chamberZs(c); for (const p of corners(c, c.wall)) pts.push([p[0], p[1], zb], [p[0], p[1], zl]); }
  for (const o of state.obstacles) for (const p of boxCorners(o, 0)) pts.push([p[0], p[1], Math.min(o.zTop, o.zBot)], [p[0], p[1], Math.max(o.zTop, o.zBot)]);
  for (const cn of state.connections) if (cn.placed && cn.route && cn.route.ok) for (const line of run3d(cn)) pts.push(...line);
  if (!pts.length){ Object.assign(cam, {cx:0, cy:0, cz:0, s:0.03, px:0, py:0}); return draw3d(); }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let i = 0; i < 3; i++){ lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
  cam.cx = (lo[0]+hi[0])/2; cam.cy = (lo[1]+hi[1])/2; cam.cz = (lo[2]+hi[2])/2;
  cam.s = 1; cam.px = 0; cam.py = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts){ const q = proj(p); x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
  cam.s = Math.max(0.0005, Math.min(3, Math.min((r.width-2*pad)/Math.max(1, x1-x0), (r.height-2*pad)/Math.max(1, y1-y0))));
  cam.px = -((x0+x1)/2 - r.width/2)*cam.s;
  cam.py = -((y0+y1)/2 - r.height/2)*cam.s;
  cam.pivotKey = '';                       // the selection, if any, takes the pivot again on the next draw
  draw3d();
}

/** The centre of whatever is selected: the point the 3D view orbits about. */
function pivotOf(sel){
  if (sel.kind === 'chamber'){ const c = byUid(sel.id); if (!c) return null; const [zb, zl] = chamberZs(c); return [c.x, c.y, (zb+zl)/2]; }
  if (sel.kind === 'obstacle'){ const o = obsBy(sel.id); return o ? [o.x, o.y, (o.zTop+o.zBot)/2] : null; }
  const cn = connBy(sel.id);
  if (!cn) return null;
  const lines = run3d(cn);
  if (lines.length && lines[0].length){ const m = [0, 0, 0]; for (const p of lines[0]){ m[0] += p[0]; m[1] += p[1]; m[2] += p[2]; } return m.map(v => v/lines[0].length); }
  const A = byUid(cn.a.mh), B = byUid(cn.b.mh);
  return A && B ? [(A.x+B.x)/2, (A.y+B.y)/2, (chamberZ0(A)+chamberZ0(B))/2] : null;
}
/** Move the pivot to P without the view moving: P keeps its place on screen. */
function setPivot(P){
  const cam = state.cam, q = proj(P);
  cam.cx = P[0]; cam.cy = P[1]; cam.cz = P[2];
  cam.px = q[0] - stageW/2; cam.py = q[1] - stageH/2;
}
function draw3d(){
  if (!state.view3d) return;
  const r = v3Rect(); stageW = r.width; stageH = r.height;
  if (!(r.width > 0 && r.height > 0)) return;
  const cam = state.cam, s = cam.s, prims = [], out = [];
  const pk = state.sel ? state.sel.kind + ':' + state.sel.id : '';          // a new selection becomes the pivot
  if (pk && pk !== cam.pivotKey){ const P = pivotOf(state.sel); if (P) setPivot(P); cam.pivotKey = pk; }
  const fp = q => q[0].toFixed(1) + ',' + q[1].toFixed(1);
  const polyStr = qs => qs.map(fp).join(' ');
  const line = (a, b, attrs) => `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" ${attrs}/>`;
  const isOn = (kind, id) => inSel(kind, id);

  out.push(`<defs><pattern id="obs" patternUnits="userSpaceOnUse" width="9" height="9" patternTransform="rotate(-45)">
      <line x1="0" y1="0" x2="0" y2="9" stroke="${C.obsHatch}" stroke-width="1.4"/></pattern></defs>`);

  /* ground grid at Z 0 across the drawing's footprint */
  const ext = drawingExtent();
  if (state.showGrid && ext){
    const st = gridStep(s), m = st*2;
    const gx0 = Math.floor((ext[0]-m)/st)*st, gx1 = Math.ceil((ext[2]+m)/st)*st;
    const gy0 = Math.floor((ext[1]-m)/st)*st, gy1 = Math.ceil((ext[3]+m)/st)*st;
    for (let x = gx0; x <= gx1 + 1e-6; x += st){
      const k = Math.round(x/st), col = k === 0 ? C.axisY : k % 5 === 0 ? C.gridMajor : C.gridMinor;
      out.push(line(proj([x, gy0, state.ground]), proj([x, gy1, state.ground]), `stroke="${col}" stroke-width="1"`));
    }
    for (let y = gy0; y <= gy1 + 1e-6; y += st){
      const k = Math.round(y/st), col = k === 0 ? C.axisX : k % 5 === 0 ? C.gridMajor : C.gridMinor;
      out.push(line(proj([gx0, y, state.ground]), proj([gx1, y, state.ground]), `stroke="${col}" stroke-width="1"`));
    }
  }

  /* boxes: six faces each, sorted with everything else by nearness */
  const box = (pts4, zlo, zhi, fill, op, stroke, sw, pick, hatch) => {
    const lo = pts4.map(p => [p[0], p[1], zlo]), hi = pts4.map(p => [p[0], p[1], zhi]);
    const faces = [lo, hi];
    for (let i = 0; i < 4; i++){ const j = (i+1)%4; faces.push([lo[i], lo[j], hi[j], hi[i]]); }
    for (const f of faces){
      const q = f.map(proj), near = q.reduce((a, v) => a + v[2], 0)/q.length;
      let svg = `<polygon points="${polyStr(q)}" fill="${fill}" fill-opacity="${op}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>`;
      if (hatch) svg += `<polygon points="${polyStr(q)}" fill="url(#obs)" opacity=".7"/>`;
      prims.push({near, pick, poly:q, svg});
    }
  };
  const label = (p, text, colour, size = 11) => {
    const q = proj(p);
    prims.push({near:Infinity, svg:`<text x="${q[0].toFixed(1)}" y="${(q[1]-6).toFixed(1)}" fill="${colour}" font-family="${C.mono}" font-size="${size}" text-anchor="middle">${esc(text)}</text>`});
  };
  /* the buffer zone of a chamber or obstacle, as a dotted box, like the plan's dashed outline */
  const dotted = (pts4, zlo, zhi) => {
    const lo = pts4.map(p => proj([p[0], p[1], zlo])), hi = pts4.map(p => proj([p[0], p[1], zhi]));
    for (let i = 0; i < 4; i++){
      const j = (i+1)%4;
      for (const [a, b] of [[lo[i], lo[j]], [hi[i], hi[j]], [lo[i], hi[i]]])
        prims.push({near:(a[2]+b[2])/2 - 1e-3, svg: line(a, b, `stroke="${C.inkFaint}" stroke-width="1" stroke-dasharray="2 4" opacity=".7"`)});
    }
  };
  for (const o of state.obstacles){
    if (!isVisible(o)) continue;
    const on = isOn('obstacle', o.uid), zb = Math.min(o.zTop, o.zBot), zt = Math.max(o.zTop, o.zBot);
    box(boxCorners(o, 0), zb, zt, C.obsFill, .92, on ? C.sel : C.obsLine, on ? 1.8 : 1.1, {kind:'obstacle', id:o.uid}, true);
    if (o.buffer > 0) dotted(boxCorners(o, o.buffer), zb, zt);
    if (Math.min(o.w, o.d)*s > 18) label([o.x, o.y, zt], o.name, on ? C.sel : C.obsLine);
  }
  for (const c of state.chambers){
    if (!isVisible(c)) continue;
    const on = isOn('chamber', c.uid), [zb, zl] = chamberZs(c);
    box(corners(c, c.wall), zb, zl, C.chamber, .94, on ? C.sel : C.ink, on ? 1.8 : 1.1, {kind:'chamber', id:c.uid});
    if (c.buffer > 0) dotted(corners(c, c.wall + c.buffer), zb, zl);
    if ((c.intX + 2*c.wall)*s > 18) label([c.x, c.y, zl], c.ref, on ? C.sel : C.ink, 12);   // the window is smaller than the stage was: label sooner
  }

  /* conduits: every column and row of every run, segment by segment */
  for (const cn of state.connections){
    if (!isVisible(cn)) continue;
    const rt = cn.route, sp = specOf(cn), on = isOn('conn', cn.uid);
    const A = byUid(cn.a.mh), B = byUid(cn.b.mh);
    if (!A || !B) continue;
    if (!cn.placed || !rt || !rt.ok){
      const ea = entryFor(cn,'a'), eb = entryFor(cn,'b');
      if (!ea || !eb) continue;
      const za = chamberZ0(A) - (cn.level|0)*A.zSpace, zb = chamberZ0(B) - (cn.level|0)*B.zSpace;
      const p = proj([ea.point[0], ea.point[1], za]), q = proj([eb.point[0], eb.point[1], zb]);
      const col = rt && !rt.ok ? C.bad : (on ? C.sel : C.ghost);
      prims.push({near:(p[2]+q[2])/2, pick:{kind:'conn', id:cn.uid}, seg:[p, q], tol:8,
        svg: line(p, q, `stroke="${col}" stroke-width="${on ? 1.8 : 1.2}" stroke-dasharray="6 5" opacity=".85"`)});
      continue;
    }
    const body = Math.max(1.5, 2*sp.radius*s), edge = on ? C.sel : sp.colour;
    const EL = encasement3d(cn);                       // the box as a solid: its four faces, segment by segment
    if (EL.length === 4){
      const [TL, TR, BL, BR] = EL.map(pl => pl.map(proj));
      const n = Math.min(TL.length, TR.length, BL.length, BR.length);
      for (let i = 0; i < n-1; i++)
        for (const f of [[TL[i], TR[i], TR[i+1], TL[i+1]], [BL[i], BR[i], BR[i+1], BL[i+1]], [TL[i], BL[i], BL[i+1], TL[i+1]], [TR[i], BR[i], BR[i+1], TR[i+1]]]){
          const near = f.reduce((a, v) => a + v[2], 0)/4;
          prims.push({near: near + 0.5, pick:{kind:'conn', id:cn.uid}, poly:f,
            svg:`<polygon points="${polyStr(f)}" fill="${sp.colour}" fill-opacity=".13" stroke="${edge}" stroke-width="0.8" stroke-linejoin="round" opacity=".75"/>`});
        }
    }
    for (const pl of run3d(cn)){
      const q = pl.map(proj);
      for (let i = 0; i < q.length-1; i++){
        const a = q[i], b = q[i+1];
        if (Math.hypot(b[0]-a[0], b[1]-a[1]) < 0.05) continue;
        prims.push({near:(a[2]+b[2])/2, pick:{kind:'conn', id:cn.uid}, seg:[a, b], tol:Math.max(6, body/2 + 2),
          svg: line(a, b, `stroke="${edge}" stroke-width="${body.toFixed(1)}" stroke-linecap="round" opacity=".95"`)});
      }
    }
  }
  prims.sort((a, b) => a.near - b.near);

  /* axis triad, bottom left */
  const o0 = [cam.cx, cam.cy, cam.cz], base = proj(o0), tri = [];
  const ox = 46, oy = stageH - 62;
  for (const [v, col, name] of [[[1,0,0], '#e0655f', 'X'], [[0,1,0], '#6bd68a', 'Y'], [[0,0,1], C.pick, 'Z']]){
    const q = proj([o0[0]+v[0], o0[1]+v[1], o0[2]+v[2]]);
    const dx = (q[0]-base[0])/cam.s, dy = (q[1]-base[1])/cam.s;   // unit direction on screen
    tri.push(`<line x1="${ox}" y1="${oy}" x2="${(ox+dx*24).toFixed(1)}" y2="${(oy+dy*24).toFixed(1)}" stroke="${col}" stroke-width="1.6"/>`);
    tri.push(`<text x="${(ox+dx*33).toFixed(1)}" y="${(oy+dy*33+3.5).toFixed(1)}" fill="${col}" font-family="${C.mono}" font-size="10" text-anchor="middle">${name}</text>`);
  }

  SVG3.setAttribute('viewBox', `0 0 ${stageW} ${stageH}`);
  SVG3.innerHTML = out.join('') + prims.map(p => p.svg).join('') + tri.join('');
  prims3d = prims;
}

/** Nearest thing under a screen point: front faces first, conduits by distance. */
function pick3d(sp){
  for (let i = prims3d.length-1; i >= 0; i--){
    const p = prims3d[i];
    if (!p.pick) continue;
    if (p.poly && pointInPoly(sp, p.poly)) return p.pick;
    if (p.seg && distToSeg(sp, p.seg[0], p.seg[1]) < p.tol) return p.pick;
  }
  return null;
}
function pointer3dDown(e, sp){
  drag3 = {sx:sp[0], sy:sp[1], az:state.cam.az, el:state.cam.el, px:state.cam.px, py:state.cam.py,
           pan: e.button === 1 ? !e.shiftKey : (e.shiftKey || e.button === 2),   // middle pans, shift+middle orbits, as Revit; right pans
           button:e.button, moved:false,
           slop: e.pointerType === 'mouse' ? 3 : SLOP};
}
function pointer3dMove(e, sp){
  if (!drag3){ V3BODY.style.cursor = pick3d(sp) ? 'pointer' : 'grab'; return; }
  const dx = sp[0]-drag3.sx, dy = sp[1]-drag3.sy;
  if (!drag3.moved){ if (Math.hypot(dx, dy) <= drag3.slop) return; drag3.moved = true; }
  if (drag3.pan){ state.cam.px = drag3.px + dx; state.cam.py = drag3.py + dy; }
  else { state.cam.az = drag3.az - dx*0.4; state.cam.el = Math.max(5, Math.min(89.5, drag3.el + dy*0.4)); }
  V3BODY.style.cursor = drag3.pan ? 'move' : 'grabbing';
  draw3d();
}
function pointer3dUp(e, sp){
  const d = drag3; drag3 = null;
  V3BODY.style.cursor = 'grab';
  if (!d || d.moved) return;
  if (d.button === 2 || e.ctrlKey){ radial3At(sp); return; }
  const h = pick3d(sp); select(h ? h.kind : null, h ? h.id : null);
}
/** The 3D view lives in its own window: opening it fits the drawing, closing it leaves the plan as it was. */
function setView3d(on){ if (on) openWin('view3d'); else closeWin('view3d'); }

/* ---------- the 3D window's own pointer, wheel and finger handling ---------- */
const touches3 = new Map(); let pinch3 = null, hold3 = null, rest3 = false;
const pt3 = e => { const r = SVG3.getBoundingClientRect(); return [e.clientX-r.left, e.clientY-r.top]; };
const cancelHold3 = () => { if (hold3){ clearTimeout(hold3.t); hold3 = null; } };
const clampS = v => Math.max(0.0004, Math.min(4, v));
function startPinch3(){
  cancelHold3(); drag3 = null;
  const [a, b] = [...touches3.values()], r = v3Rect(), cam = state.cam;
  pinch3 = {d0:Math.max(1, Math.hypot(b[0]-a[0], b[1]-a[1])), mid0:[(a[0]+b[0])/2, (a[1]+b[1])/2], W:r.width, H:r.height, s0:cam.s};
  pinch3.X0 = (pinch3.mid0[0] - r.width/2 - cam.px)/cam.s; pinch3.U0 = (r.height/2 + cam.py - pinch3.mid0[1])/cam.s;
}
function movePinch3(){
  const [a, b] = [...touches3.values()], cam = state.cam;
  const d = Math.max(1, Math.hypot(b[0]-a[0], b[1]-a[1])), mid = [(a[0]+b[0])/2, (a[1]+b[1])/2];
  const ns = clampS(pinch3.s0 * d/pinch3.d0);
  cam.s = ns; cam.px = mid[0] - pinch3.W/2 - pinch3.X0*ns; cam.py = mid[1] - pinch3.H/2 + pinch3.U0*ns;
  draw3d();
}
function endTouch3(e){
  if (!coarse(e)) return false;
  cancelHold3();
  if (e.pointerType === 'touch') touches3.delete(e.pointerId);
  const rest = rest3 || !!pinch3;
  if (pinch3 && touches3.size < 2) pinch3 = null;
  rest3 = touches3.size > 0 && rest;
  return rest;
}
SVG3.addEventListener('pointerdown', e => {
  if (e.target.closest && e.target.closest('#radial')){ ringArmed = true; return; }
  closeRadial();
  const sp = pt3(e);
  if (e.pointerType === 'touch'){
    touches3.set(e.pointerId, sp);
    if (touches3.size >= 2){ e.preventDefault(); startPinch3(); return; }
  }
  if (rest3) return;
  e.preventDefault();
  SVG3.setPointerCapture(e.pointerId);
  if (coarse(e)) hold3 = {sp, t:setTimeout(() => { hold3 = null; drag3 = null; rest3 = true; radial3At(sp); ringArmed = false; }, 500)};
  pointer3dDown(e, sp);
});
SVG3.addEventListener('pointermove', e => {
  const sp = pt3(e);
  if (e.pointerType === 'touch' && touches3.has(e.pointerId)){
    touches3.set(e.pointerId, sp);
    if (pinch3 && touches3.size >= 2){ movePinch3(); return; }
  }
  if (rest3) return;
  if (hold3 && Math.hypot(sp[0]-hold3.sp[0], sp[1]-hold3.sp[1]) > SLOP) cancelHold3();
  pointer3dMove(e, sp);
});
SVG3.addEventListener('pointerup', e => {
  if (e.target.closest && e.target.closest('#radial')) return;
  const sp = pt3(e);
  if (endTouch3(e)){ drag3 = null; return; }
  pointer3dUp(e, sp);
});
SVG3.addEventListener('pointercancel', e => { endTouch3(e); drag3 = null; });
SVG3.addEventListener('contextmenu', e => e.preventDefault());
SVG3.addEventListener('touchmove', e => e.preventDefault(), {passive:false});
SVG3.addEventListener('gesturestart', e => e.preventDefault());
SVG3.addEventListener('wheel', e => {
  e.preventDefault(); closeRadial();
  const r = v3Rect(), sp = pt3(e), cam = state.cam;
  const k = e.ctrlKey && Math.abs(e.deltaY) < 50 ? 0.012 : 0.0016;
  const ns = clampS(cam.s*Math.exp(-e.deltaY*k)), g = ns/cam.s;
  cam.px = sp[0] - r.width/2 - (sp[0] - r.width/2 - cam.px)*g;   // keep the point under the cursor still
  cam.py = sp[1] - r.height/2 - (sp[1] - r.height/2 - cam.py)*g;
  cam.s = ns;
  draw3d();
}, {passive:false});
new ResizeObserver(() => { if (state.view3d) draw3d(); }).observe(V3BODY);   // a stretched window redraws to fit
document.getElementById('btnFit3d').onclick = () => fit3d();
/** The ring for whatever sits under a still right-click or a held finger in the 3D window. */
function radial3At(sp){
  const h = pick3d(sp);
  if (h) keepSel(h.kind, h.id);
  const m = h ? (h.kind === 'chamber' ? chamberMenu(byUid(h.id)) : h.kind === 'obstacle' ? obstacleMenu(obsBy(h.id)) : runMenu(connBy(h.id)))
              : ['3D view', [{icon:'fit', label:'Fit view', run:() => fit3d()}, {icon:'runs', label:'Runs', run:() => openWin('runs')},
                             {icon:'plan', label:'Close 3D', run:() => closeWin('view3d')}]];
  openRadial(sp, m[0], m[1], V3BODY);
}

/* ==========================================================================
   HIT TESTING
   ========================================================================== */

function hitFace(world, tolPx = 9){
  const tol = tolPx/state.view.s;
  let best = null, bestD = Infinity;
  for (const c of state.chambers) for (const f of FACES){
    if (!isVisible(c)) continue;
    const g = faceGeom(c, f), d = distToSeg(world, g.p1, g.p2);
    if (d < tol && d < bestD){ bestD = d; best = {mh:c.uid, face:f}; }
  }
  return best;
}
function hitChamber(w){
  for (let i = state.chambers.length-1; i >= 0; i--)
    if (isVisible(state.chambers[i]) && pointInPoly(w, corners(state.chambers[i], state.chambers[i].wall))) return state.chambers[i];
  return null;
}
function hitObstacle(w){
  for (let i = state.obstacles.length-1; i >= 0; i--)
    if (isVisible(state.obstacles[i]) && pointInPoly(w, boxCorners(state.obstacles[i], 0))) return state.obstacles[i];
  return null;
}
function hitConnection(w, tolPx = 8){
  let best = null, bestD = Infinity;
  for (const cn of state.connections){
    if (!isVisible(cn)) continue;
    const rt = cn.route;
    let line;
    if (cn.placed && rt && rt.ok) line = rt.poly;
    else {
      const ea = entryFor(cn,'a'), eb = entryFor(cn,'b');
      if (!ea || !eb) continue;
      line = [ea.point, eb.point];
    }
    const tol = Math.max(tolPx/state.view.s, cn.placed ? specOf(cn).radius : 0);
    for (let i = 0; i < line.length-1; i++){
      const d = distToSeg(w, line[i], line[i+1]);
      if (d < tol && d < bestD){ bestD = d; best = cn; }
    }
  }
  return best;
}

/* ==========================================================================
   POINTER
   ========================================================================== */

let drag = null;
const touches = new Map();          // active touch pointers → [x, y] on the stage
let pinch = null;                   // two-finger pinch in progress
let touchRest = false;              // a finger left over from a pinch or a long press rests until it lifts
let hold = null;                    // long-press timer: a finger or pencil held still opens the ring, as a right-click does
const SLOP = 8;                     // px a finger may wander before a tap becomes a drag

const stagePt = e => { const r = STAGE.getBoundingClientRect(); return [e.clientX-r.left, e.clientY-r.top]; };
const isPan = e => e.button === 1 || e.button === 2;
const coarse = e => e.pointerType === 'touch' || e.pointerType === 'pen';   // no buttons, no hover, a fatter point

function cancelHold(){ if (hold){ clearTimeout(hold.t); hold = null; } }
/** A drag overtaken by a pinch or a long press leaves nothing behind. */
function abandonDrag(){
  if (drag && drag.kind === 'move'){
    if (drag.moved) for (const it of drag.items){ it.obj.x = it.x0; it.obj.y = it.y0; }
    ROUTE_QUICK = false; renderSel(); renderConnections();
  }
  drag = null; drag3 = null; state.rubber = null;
}
function startPinch(){
  cancelHold(); abandonDrag();
  const [a, b] = [...touches.values()];
  const r = STAGE.getBoundingClientRect();
  pinch = {d0: Math.max(1, Math.hypot(b[0]-a[0], b[1]-a[1])), mid0: [(a[0]+b[0])/2, (a[1]+b[1])/2], W:r.width, H:r.height,
           s0: state.view.s, w0: S2W([(a[0]+b[0])/2, (a[1]+b[1])/2])};
}
function movePinch(){
  const [a, b] = [...touches.values()];
  const d = Math.max(1, Math.hypot(b[0]-a[0], b[1]-a[1])), mid = [(a[0]+b[0])/2, (a[1]+b[1])/2];
  const ns = Math.max(0.0004, Math.min(4, pinch.s0 * d/pinch.d0));
  state.view.s = ns; state.view.tx = mid[0] - pinch.w0[0]*ns; state.view.ty = mid[1] + pinch.w0[1]*ns;
  draw();
}

STAGE.addEventListener('pointerdown', e => {
  if (e.target.closest && e.target.closest('#radial')){ ringArmed = true; return; }     // the menu handles its own clicks
  closeRadial();
  const sp = stagePt(e);
  if (e.pointerType === 'touch'){
    touches.set(e.pointerId, sp);
    if (touches.size >= 2){ e.preventDefault(); startPinch(); return; }
  }
  if (touchRest) return;
  e.preventDefault();                       // stop native text selection and middle-button autoscroll
  STAGE.setPointerCapture(e.pointerId);
  if (coarse(e)) hold = {sp, t:setTimeout(() => { hold = null; abandonDrag(); touchRest = true; radialAt(sp, true); ringArmed = false; }, 500)};
  if (isPan(e)){                            // middle or right button drags the view; a still right-click opens the ring
    drag = {kind:'pan', sx:sp[0], sy:sp[1], tx:state.view.tx, ty:state.view.ty, button:e.button, moved:false};
    return;
  }
  const wp = S2W(sp);
  if (performance.now() - lastConnect < 700 && hitFace(wp, coarse(e) ? 20 : 12)){ cancelHold(); return; }   // the second click of the double that just connected
  if (state.pending){                       // a connection begun from a face: a click on another face completes it
    const f = hitFace(wp, coarse(e) ? 20 : 12);
    if (f){ cancelHold(); pickFace(f); return; }
    state.pending = null; setPendingStatus();
  }
  const grab = (kind, obj) => {
    if (!inSel(kind, obj.uid)) select(kind, obj.uid); else setPrimary(kind, obj.uid);
    if (kind === 'chamber' && !chamberMovable(obj)){ noteLocked(obj); return; }       // locked or static: selected, never dragged
    const items = movables().map(m => ({obj:m, x0:m.x, y0:m.y}));
    if (!items.length) return;
    drag = {kind:'move', wp0:wp, sx:sp[0], sy:sp[1], slop: coarse(e) ? SLOP : 0, items, moved:false, axisRot: obj.rot || 0};   // the grabbed one's own axes, for ctrl+shift
    ROUTE_QUICK = true;
  };
  const c = hitChamber(wp);
  if (c){ grab('chamber', c); return; }
  const o = hitObstacle(wp);
  if (o){ grab('obstacle', o); return; }
  const cn = hitConnection(wp, coarse(e) ? 14 : 8);
  if (cn){ if (!inSel('conn', cn.uid)) select('conn', cn.uid); else setPrimary('conn', cn.uid); return; }
  drag = {kind:'box', sx:sp[0], sy:sp[1], moved:false, ctrl:e.ctrlKey};       // empty space: a selection rectangle
});

STAGE.addEventListener('pointermove', e => {
  const sp = stagePt(e), wp = S2W(sp);
  if (e.pointerType === 'touch' && touches.has(e.pointerId)){
    touches.set(e.pointerId, sp);
    if (pinch && touches.size >= 2){ movePinch(); return; }
  }
  if (touchRest) return;
  if (hold && Math.hypot(sp[0]-hold.sp[0], sp[1]-hold.sp[1]) > SLOP) cancelHold();
  document.getElementById('rx').textContent = fmt(wp[0]);
  document.getElementById('ry').textContent = fmt(wp[1]);

  if (drag && drag.kind === 'pan'){
    if (Math.hypot(sp[0]-drag.sx, sp[1]-drag.sy) > 3) drag.moved = true;
    state.view.tx = drag.tx + (sp[0]-drag.sx);
    state.view.ty = drag.ty + (sp[1]-drag.sy);
    return draw();
  }
  if (drag && drag.kind === 'move'){
    if (!drag.moved && Math.hypot(sp[0]-drag.sx, sp[1]-drag.sy) <= drag.slop) return;
    drag.moved = true;
    let dx = wp[0]-drag.wp0[0], dy = wp[1]-drag.wp0[1];
    let exact = false;
    if (e.shiftKey){
      if (e.ctrlKey || e.metaKey){                    // ctrl+shift: along the grabbed chamber's own axes, as it is turned
        const r = (drag.axisRot || 0)*D2R, u = [Math.cos(r), Math.sin(r)], v = [-u[1], u[0]];
        const a = snap(dx*u[0] + dy*u[1]), b = snap(dx*v[0] + dy*v[1]);
        if (Math.abs(a) >= Math.abs(b)){ dx = u[0]*a; dy = u[1]*a; } else { dx = v[0]*b; dy = v[1]*b; }
        exact = true;
      } else if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0;   // shift holds the drag to one line
    }
    for (const it of drag.items){ it.obj.x = exact ? Math.round(it.x0 + dx) : snap(it.x0 + dx); it.obj.y = exact ? Math.round(it.y0 + dy) : snap(it.y0 + dy); }
    renderSel(); renderConnections(); return draw();
  }
  if (drag && drag.kind === 'box'){
    if (Math.hypot(sp[0]-drag.sx, sp[1]-drag.sy) > 3) drag.moved = true;
    state.rubber = drag.moved ? {x0:drag.sx, y0:drag.sy, x1:sp[0], y1:sp[1]} : null;
    return draw();
  }
  if (!RADIAL.hidden) return;               // the ring is up: no hover business underneath it
  const f = hitFace(wp);
  const changed = JSON.stringify(f) !== JSON.stringify(state.hoverFace);
  state.hoverFace = f;
  showCallout(f, sp);
  STAGE.style.cursor = state.pending ? (f ? 'pointer' : 'crosshair')
    : hitChamber(wp) ? (chamberMovable(hitChamber(wp)) ? 'move' : 'pointer') : hitObstacle(wp) ? 'move' : hitConnection(wp) ? 'pointer' : 'crosshair';
  if (changed) draw();
});

/** A lifted finger: true when nothing more should come of it (it pinched, or rested). */
function endTouch(e){
  if (!coarse(e)) return false;
  cancelHold();
  if (e.pointerType === 'touch') touches.delete(e.pointerId);
  const rest = touchRest || !!pinch;
  if (pinch && touches.size < 2) pinch = null;
  touchRest = touches.size > 0 && rest;     // a finger left behind rests; the last one lifting clears it
  return rest;
}
STAGE.addEventListener('pointerup', e => {
  if (e.target.closest && e.target.closest('#radial')) return;
  const sp = stagePt(e);
  if (endTouch(e)) return;
  const d = drag; drag = null;
  if ((!d || !d.moved) && !(d && d.kind === 'pan')){           // two clicks or taps on one spot: a double
    const now = performance.now();
    if (lastTap && now - lastTap.t < 400 && Math.hypot(sp[0]-lastTap.sp[0], sp[1]-lastTap.sp[1]) < 30){
      lastTap = null;
      const f = hitFace(S2W(sp), coarse(e) ? 20 : 12);
      if (f){ ROUTE_QUICK = false; faceTwice(f); renderSel(); renderConnections(); draw(); return; }
    } else lastTap = {t:now, sp};
  }
  if (d && d.kind === 'pan'){
    if (!d.moved && (d.button === 2 || e.ctrlKey)) radialAt(sp);
    return;
  }
  if (d && d.kind === 'box'){
    state.rubber = null;
    if (d.moved){
      const a = S2W([d.sx, d.sy]), b = S2W(sp);
      selectSet(rectSel(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), sp[0] < d.sx));
    } else select(null);
    return;
  }
  if (ROUTE_QUICK){ ROUTE_QUICK = false; renderSel(); renderConnections(); draw(); }
  historyMark();
});
STAGE.addEventListener('pointercancel', e => { endTouch(e); abandonDrag(); });
STAGE.addEventListener('pointerleave', () => {
  state.hoverFace = null; showCallout(null); draw();
  document.getElementById('rx').textContent = '—';
  document.getElementById('ry').textContent = '—';
});
/** The ring for whatever sits under a still right-click (or ctrl-click, or a held finger — `big` widens the hit). */
const keepSel = (kind, id) => { if (!inSel(kind, id)) select(kind, id); else setPrimary(kind, id); };   // a ring on a selected thing keeps the set
function radialAt(sp, big){
  const keep = keepSel;
  const wp = S2W(sp);
  const f = hitFace(wp, big ? 18 : 9);
  if (f) return openRadial(sp, ...faceMenu(f));
  const c = hitChamber(wp);
  if (c){ keep('chamber', c.uid); return openRadial(sp, ...chamberMenu(c)); }
  const o = hitObstacle(wp);
  if (o){ keep('obstacle', o.uid); return openRadial(sp, ...obstacleMenu(o)); }
  const cn = hitConnection(wp, big ? 14 : 8);
  if (cn){ keep('conn', cn.uid); return openRadial(sp, ...runMenu(cn)); }
  openRadial(sp, ...spaceMenu(wp));
}
STAGE.addEventListener('contextmenu', e => e.preventDefault());      // the ring is opened from pointerup instead
STAGE.addEventListener('touchmove', e => e.preventDefault(), {passive:false});   // no page scroll or rubber-banding under a gesture
STAGE.addEventListener('gesturestart', e => e.preventDefault());               // Safari's page pinch stays out of the drawing
STAGE.addEventListener('wheel', e => {
  e.preventDefault();
  closeRadial();
  const r = STAGE.getBoundingClientRect();
  const sp = [e.clientX-r.left, e.clientY-r.top], before = S2W(sp);
  /* a touchpad pinch arrives as a wheel with ctrl held and small deltas */
  const k = e.ctrlKey && Math.abs(e.deltaY) < 50 ? 0.012 : 0.0016;
  state.view.s = Math.max(0.0004, Math.min(4, state.view.s*Math.exp(-e.deltaY*k)));
  const after = S2W(sp);
  state.view.tx += (after[0]-before[0])*state.view.s;
  state.view.ty -= (after[1]-before[1])*state.view.s;
  draw();
}, {passive:false});

const snap = v => state.snap > 0 ? Math.round(v/state.snap)*state.snap : Math.round(v);

function showCallout(f, sp){
  const el = document.getElementById('callout');
  if (!f){ el.style.display = 'none'; return; }
  const c = byUid(f.mh), g = faceGeom(c, f.face);
  const k = faceRuns(f.mh, f.face).length;
  el.innerHTML = `<u>${esc(c.ref)} · ${f.face} face${c.sides && c.sides[f.face] ? ' · ' + esc(c.sides[f.face]) : ''}</u>\n`
    + `internal face   ${fmt(g.width)} wide\n`
    + `mid  X ${fmt(g.mid[0])}  Y ${fmt(g.mid[1])}\n`
    + `outward bearing ${g.bearing.toFixed(1)}°`
    + (k ? `\nruns on face    ${k} at ${fmt(c.latSpace)} centres` : '');
  el.style.display = 'block';
  el.style.left = Math.min(sp[0]+16, STAGE.clientWidth-210) + 'px';
  el.style.top  = Math.min(sp[1]+16, STAGE.clientHeight-90) + 'px';
}

/* ==========================================================================
   SELECTION + CONNECTIONS
   ========================================================================== */

function select(kind, id){
  state.sel = kind ? {kind, id} : null;
  state.selSet = kind ? [{kind, id}] : [];
  renderSel(); renderConnections(); renderObstacles(); draw();
}
/** Select a whole set; the first chamber (else obstacle, else run) is primary. */
function selectSet(set){
  const prim = set.find(x => x.kind === 'chamber') || set.find(x => x.kind === 'obstacle') || set[0] || null;
  state.sel = prim ? {kind:prim.kind, id:prim.id} : null;
  state.selSet = set.slice();
  renderSel(); renderConnections(); renderObstacles(); draw();
}
function setPrimary(kind, id){
  state.sel = {kind, id};
  if (!inSel(kind, id)) state.selSet.push({kind, id});
  renderSel(); renderConnections(); renderObstacles(); draw();
}
/** What a selection rectangle (world coordinates) takes: a WINDOW (dragged
    left to right) takes only what lies wholly inside; a CROSSING (dragged
    right to left) takes anything it touches. */
function rectSel(x0, y0, x1, y1, crossing){
  const inside = p => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
  const rp = [[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
  const edges = [[rp[0],rp[1]],[rp[1],rp[2]],[rp[2],rp[3]],[rp[3],rp[0]]];
  const cuts = (a, b) => edges.some(([p, q]) => segSegDist(a, b, p, q) < 1);
  const polyHit = pts => crossing
    ? pts.some(inside) || rp.some(p => pointInPoly(p, pts)) || pts.some((p, i) => cuts(pts[i ? i-1 : pts.length-1], p))
    : pts.every(inside);
  const lineHit = pts => crossing ? pts.some(inside) || pts.some((p, i) => i > 0 && cuts(pts[i-1], p)) : pts.every(inside);
  const set = [];
  for (const c of state.chambers) if (isVisible(c) && polyHit(corners(c, c.wall))) set.push({kind:'chamber', id:c.uid});
  for (const o of state.obstacles) if (isVisible(o) && polyHit(boxCorners(o, 0))) set.push({kind:'obstacle', id:o.uid});
  for (const cn of state.connections){
    if (!isVisible(cn)) continue;
    const rt = cn.route; let pts;
    if (cn.placed && rt && rt.ok) pts = rt.poly;
    else { const ea = entryFor(cn,'a'), eb = entryFor(cn,'b'); if (!ea || !eb) continue; pts = [ea.point, eb.point]; }
    if (lineHit(pts)) set.push({kind:'conn', id:cn.uid});
  }
  return set;
}
/** A chamber moves unless the drawing locks its manholes or its layer is static. */
const chamberMovable = c => !(state.lockChambers || (c && layerMode(c) === 'static'));
const movables = () => state.selSet.map(x => x.kind === 'chamber' ? (chamberMovable(byUid(x.id)) ? byUid(x.id) : null) : x.kind === 'obstacle' ? obsBy(x.id) : null).filter(Boolean);
const noteLocked = c => { document.getElementById('rmode').textContent = c && !state.lockChambers && layerMode(c) === 'static'
  ? `${c.ref} is on the static layer ${layerOf(c).name} — it does not move`
  : 'manholes are locked — untick Lock manholes in the Drawing window to move them'; };
/** The status line while a connection is being made from a face. */
function setPendingStatus(){
  const el = document.getElementById('rmode');
  if (state.pending){ const c = byUid(state.pending.mh); el.textContent = `connecting from ${c ? c.ref : '?'}·${state.pending.face} — click another face, or right-click it · Esc cancels`; }
  else if (/^connect/.test(el.textContent)) el.textContent = '';
}
function pickFace(f){
  if (!state.pending){ state.pending = f; setPendingStatus(); draw(); return; }
  lastConnect = performance.now();          // the pick is done with: a second click of a double on this face changes nothing
  if (state.pending.mh === f.mh && state.pending.face === f.face){ state.pending = null; setPendingStatus(); draw(); return; }
  const same = (x,y) => x.mh === y.mh && x.face === y.face;
  const dup = state.connections.find(c =>
    (same(c.a, state.pending) && same(c.b, f)) || (same(c.b, state.pending) && same(c.a, f)));
  if (dup){ state.pending = null; setPendingStatus(); select('conn', dup.uid); return; }
  const cn = {uid:uid(), a:state.pending, b:f, placed:true, level:0, perRow:[1], align:'auto', layer: activeLayerId(),     // made and placed at once: nothing to approve
              specId:(state.editSpec || state.specs[0].id), route:null};
  state.connections.push(cn);
  state.pending = null; setPendingStatus();
  select('conn', cn.uid);
  document.getElementById('rmode').textContent = `connected ${connLabel(cn)}`;
}
let lastConnect = -1e9, lastTwice = -1e9, lastTap = null;
/** A face double-clicked or double-tapped (two still presses within a moment): begin a connection there, or complete one begun elsewhere. */
function faceTwice(f){
  const now = performance.now();
  if (now - lastConnect < 700 || now - lastTwice < 500) return;   // the clicks that just completed a run, or a double already taken
  lastTwice = now;
  pickFace(f);
}
function disconnect(u){
  state.connections = state.connections.filter(c => c.uid !== u);
  if (selIs('conn') && state.sel.id === u) state.sel = null;
  select(state.sel && state.sel.kind, state.sel && state.sel.id);
}
function connLabel(cn){
  const A = byUid(cn.a.mh), B = byUid(cn.b.mh);
  return `${A?A.ref:'?'}·${cn.a.face} → ${B?B.ref:'?'}·${cn.b.face}`;
}

function renderConnections(){
  recomputeRoutes();
  historyMark();
  const box = document.getElementById('connList');
  document.getElementById('connCount').textContent = state.connections.length || '';
  if (!state.connections.length){
    box.innerHTML = `<div class="empty">None yet. Double-click a face, then double-click a face on another chamber — or right-click a face and choose <b>Connect from</b>.</div>`;
    renderLayers();
    return;
  }
  box.innerHTML = '<div class="list">' + state.connections.map(cn => {
    const rt = cn.route, sp = specOf(cn);
    const warn = rt && rt.ok && rt.warnings.length;
    const cls = !rt || !rt.ok ? 'bad' : warn ? 'warn' : cn.placed ? 'ok' : '';
    const meta = !rt || !rt.ok ? 'no route'
               : !cn.placed ? 'not placed'
               : (cn.fixed ? 'static · ' : '') + (warn ? '⚠ ' : '') + metres(rt.length3d || rt.length);
    return `<div class="item ${inSel('conn', cn.uid) ? 'on':''}" data-conn="${cn.uid}">
      <span class="dot" style="background:${sp ? sp.colour : C.inkFaint}"></span>
      <span class="nm">${esc(connLabel(cn))}</span>
      <span class="meta ${cls}">${meta}</span>
      <button class="x" data-del="${cn.uid}" title="Disconnect">×</button></div>`;
  }).join('') + '</div>';
  box.querySelectorAll('[data-conn]').forEach(el => el.onclick = () => select('conn', el.dataset.conn));
  box.querySelectorAll('[data-del]').forEach(b => b.onclick = ev => { ev.stopPropagation(); disconnect(b.dataset.del); });
  renderLayers();
}

function renderObstacles(){
  historyMark();
  const box = document.getElementById('obsList');
  document.getElementById('obsCount').textContent = state.obstacles.length || '';
  if (!state.obstacles.length){
    box.innerHTML = `<div class="empty">None. Add one with <b>+ Obstacle</b> — conduit runs are routed around it, keeping its clearance.</div>`;
    return;
  }
  box.innerHTML = '<div class="list">' + state.obstacles.map(o =>
    `<div class="item ${inSel('obstacle', o.uid) ? 'on':''}" data-obs="${o.uid}">
      <span class="dot" style="background:${C.obsLine}"></span>
      <span class="nm">${esc(o.name)}</span>
      <span class="meta">${fmt(o.w)}×${fmt(o.d)}</span>
      <button class="x" data-delobs="${o.uid}" title="Delete">×</button></div>`).join('') + '</div>';
  box.querySelectorAll('[data-obs]').forEach(el => el.onclick = () => select('obstacle', el.dataset.obs));
  box.querySelectorAll('[data-delobs]').forEach(b => b.onclick = ev => {
    ev.stopPropagation();
    state.obstacles = state.obstacles.filter(o => o.uid !== b.dataset.delobs);
    if (selIs('obstacle') && state.sel.id === b.dataset.delobs) state.sel = null;
    renderSel(); renderObstacles(); renderConnections(); draw();
  });
}

/* ==========================================================================
   CONDUIT SPECS  (left panel)
   ========================================================================== */

function specUse(id){ return state.connections.filter(c => c.specId === id).length; }

function renderSpecs(){
  historyMark();
  const box = document.getElementById('specList');
  box.innerHTML = '<div class="list">' + state.specs.map(s =>
    `<div class="item ${s.id === state.editSpec ? 'on':''}" data-spec="${s.id}">
       <span class="dot" style="background:${s.colour}"></span>
       <span class="nm">${esc(s.name)}</span>
       <span class="meta">Ø${fmt(s.radius*2)}</span></div>`).join('') + '</div>';
  box.querySelectorAll('[data-spec]').forEach(el => el.onclick = () => {
    state.editSpec = el.dataset.spec; renderSpecs(); renderSpecEdit();
  });
  document.getElementById('specDel').disabled = state.specs.length < 2;
}

function renderSpecEdit(){
  const box = document.getElementById('specEdit');
  const sp = specBy(state.editSpec);
  document.getElementById('specWho').textContent = sp ? `${specUse(sp.id)} run${specUse(sp.id)===1?'':'s'}` : '';
  if (!sp){ box.innerHTML = `<div class="empty">Pick a spec above.</div>`; return; }
  box.innerHTML =
    `<div class="row"><label for="sName">Name</label><input type="text" id="sName" value="${esc(sp.name)}"></div>
     <div class="swatches">${SPEC_COLOURS.map(c =>
        `<div class="sw ${c === sp.colour ? 'on':''}" data-col="${c}" style="background:${c}" title="${c}"></div>`).join('')}</div>` +
    cluster('spSize', 'Sizes', `Ø${fmt(sp.radius*2)} · R${fmt(sp.bendR)}`,
      numRow('sRad','Conduit radius', sp.radius, 25, 'mm') +
      numRow('sBend','Bend radius', sp.bendR, 50, 'mm')) +
    cluster('spStr', 'Minimum straights', `≥${fmt(sp.stub)} · ≥${fmt(sp.minLeg)}`,
      numRow('sStub','off chamber face', sp.stub, 50, 'mm') +
      numRow('sLeg','between bends', sp.minLeg, 50, 'mm')) +
    cluster('spSpc', 'Spacing, clearance & encasement', `clr ${fmt(sp.buffer)} · pitch ${fmt(sp.spacing || 300)}${encOf(sp) ? ' · enc +' + fmt(encOf(sp)) : ''}`,
      numRow('sBuf','Clearance', sp.buffer, 50, 'mm') +
      numRow('sSpc','Array spacing', sp.spacing || 300, 25, 'mm') +
      numRow('sEnc','Encasement offset', encOf(sp), 25, 'mm') +
      `<div class="derived"><span>The encasement is a rectangle round the whole array, this far beyond the conduits' outer diameter: as wide as the widest row, as high as all the rows. Zero means no encasement. Other runs and obstacles keep their clearance from the box.</span></div>`) +
    cluster('spRul', 'Fittings & warnings',
      sp.angles.length ? sp.angles.map(a => fmt1(a)+'°').join(' ') : 'straight only',
      numRow('sWarn','Warn above', sp.warnAngle, 5, '°') +
      `<div class="row" style="margin-top:4px"><label>Bend angles allowed</label></div>
       <div class="chips" id="sAngles">${ANGLE_OPTIONS.map(a =>
          `<button class="chip ${sp.angles.includes(a)?'on':''}" data-ang="${a}">${a}°</button>`).join('')}</div>
       <div class="derived"><b>Bore</b> ${fmt(sp.radius*2)} mm · <b>bend</b> R${fmt(sp.bendR)}<br>
         <b>Straights</b> ≥${fmt(sp.stub)} off face · ≥${fmt(sp.minLeg)} between bends<br>
         <b>Clearance</b> ${fmt(sp.buffer)} each side — pairs keep the larger clearance<br>
         <b>Array pitch</b> ${fmt(sp.spacing || 300)} — faces snap to the largest pitch present, and a run's panel sets it too<br>
         <b>Encasement</b> ${encOf(sp) ? fmt(encOf(sp)) + ' beyond the outer diameter, round the whole array' : 'none'}<br>
         <b>Fittings</b> ${sp.angles.length ? sp.angles.map(a => fmt1(a)+'°').join(' · ') : 'straight only'}</div>`);

  const bindS = (id, key, cast = Number) => {
    const el = document.getElementById(id);
    el.addEventListener('input', () => {
      const v = cast(el.value);
      if (cast === Number && (!Number.isFinite(v) || v < 0)) return;
      sp[key] = v; specChanged();
    });
  };
  bindS('sName','name',String); bindS('sRad','radius'); bindS('sBend','bendR');
  bindS('sStub','stub'); bindS('sLeg','minLeg'); bindS('sBuf','buffer'); bindS('sSpc','spacing'); bindS('sEnc','enc'); bindS('sWarn','warnAngle');
  box.querySelectorAll('[data-col]').forEach(el => el.onclick = () => {
    sp.colour = el.dataset.col; renderSpecEdit(); specChanged();
  });
  box.querySelectorAll('[data-ang]').forEach(b => b.onclick = () => {
    const a = Number(b.dataset.ang), i = sp.angles.indexOf(a);
    if (i >= 0) sp.angles.splice(i,1); else sp.angles.push(a);
    sp.angles.sort((x,y) => x-y);
    b.classList.toggle('on');
    specChanged();
  });
  wireClusters(box, renderSpecEdit);
}
function specChanged(){
  const sp = specBy(state.editSpec), der = document.querySelector('#specEdit .derived');
  if (sp && der) der.innerHTML =
    `<b>Bore</b> ${fmt(sp.radius*2)} mm · <b>bend</b> R${fmt(sp.bendR)}<br>
     <b>Straights</b> ≥${fmt(sp.stub)} off face · ≥${fmt(sp.minLeg)} between bends<br>
     <b>Encasement</b> ${encOf(sp) ? fmt(encOf(sp)) + ' beyond the outer diameter, round the whole array' : 'none'}<br>
     <b>Fittings</b> ${sp.angles.length ? sp.angles.map(a => fmt1(a)+'°').join(' · ') : 'straight only'}`;
  renderSpecs(); renderSel(); renderConnections(); draw();
}

document.getElementById('specNew').onclick = () => {
  const sp = makeSpec({name:'Spec ' + (state.specs.length+1)});
  state.specs.push(sp); state.editSpec = sp.id;
  renderSpecs(); renderSpecEdit(); renderSel();
};
document.getElementById('specDup').onclick = () => {
  const src = specBy(state.editSpec) || state.specs[0];
  const sp = makeSpec({...src, id:uid(), name: src.name + ' copy', angles:[...src.angles]});
  state.specs.push(sp); state.editSpec = sp.id;
  renderSpecs(); renderSpecEdit(); renderSel();
};
document.getElementById('specDel').onclick = () => {
  if (state.specs.length < 2) return;
  const id = state.editSpec;
  const used = specUse(id);
  if (used && !confirm(`${used} run${used===1?' is':'s are'} on this spec. They will move to "${state.specs.find(s=>s.id!==id).name}". Delete it?`)) return;
  state.specs = state.specs.filter(s => s.id !== id);
  for (const cn of state.connections) if (cn.specId === id) cn.specId = state.specs[0].id;
  state.editSpec = state.specs[0].id;
  renderSpecs(); renderSpecEdit(); renderSel(); renderConnections(); draw();
};

/* ==========================================================================
   SELECTION PANEL  (right)
   ========================================================================== */

function numRow(id, label, val, step, unit){
  return `<div class="row"><label for="${id}">${label}</label>
    <input type="number" id="${id}" value="${val}" step="${step}"><span class="unit">${unit}</span></div>`;
}

/** Collapsible property cluster: a full-width button headline carrying a live
    summary, with the fields hidden until expanded. Open state lives in
    state.openClus so it survives the constant panel re-renders. */
function cluster(key, label, summary, body){
  const open = !!(state.openClus || (state.openClus = {}))[key];
  return `<div class="clus">
    <button class="clushead${open ? ' open' : ''}" data-clus="${key}">
      <span>${label}</span><em>${summary}</em><i>${open ? '▾' : '▸'}</i></button>
    <div class="clusbody"${open ? '' : ' hidden'}>${body}</div></div>`;
}
function wireClusters(box, rerender){
  box.querySelectorAll('[data-clus]').forEach(b => b.onclick = () => {
    state.openClus[b.dataset.clus] = !state.openClus[b.dataset.clus];
    rerender();
  });
}

/** The selected item's editor goes into its own window — Chambers, Runs or
    Obstacles — whether or not that window is open; the ribbon lights the
    buttons that concern the selection. */
function renderSel(){
  recomputeRoutes();
  const cE = document.getElementById('chamberEdit'), oE = document.getElementById('obsEdit'), rE = document.getElementById('runEdit');
  const who = (id, text) => { document.getElementById(id).textContent = text; };
  cE.innerHTML = `<div class="empty">Click a chamber on the drawing, or pick one above, to edit it.</div>`;
  oE.innerHTML = `<div class="empty">Click an obstacle on the drawing, or pick one above, to edit it.</div>`;
  rE.innerHTML = `<div class="empty">Click a conduit run on the drawing, or pick one above, to edit it.</div>`;
  who('chamberWho', ''); who('obsWho', ''); who('runWho', '');
  if (selIs('chamber')){ const c = byUid(state.sel.id); if (c){ renderChamberProps(cE, c); who('chamberWho', c.ref); } }
  else if (selIs('obstacle')){ const o = obsBy(state.sel.id); if (o){ renderObstacleProps(oE, o); who('obsWho', o.name); } }
  else if (selIs('conn')){ const cn = connBy(state.sel.id); if (cn){ renderRunProps(rE, cn); who('runWho', connLabel(cn)); } }
  renderChambers();
  renderElevation();
  updateRibbon();
  historyMark();
}
function renderChambers(){
  const box = document.getElementById('chamberList');
  document.getElementById('chamberCount').textContent = state.chambers.length || '';
  if (!state.chambers.length){ box.innerHTML = `<div class="empty">None yet. Add one with <b>+ Chamber</b>, or import a Revit export from File.</div>`; return; }
  box.innerHTML = '<div class="list">' + state.chambers.map(c =>
    `<div class="item ${inSel('chamber', c.uid) ? 'on':''}" data-ch="${c.uid}">
      <span class="dot" style="background:${C.ink}"></span>
      <span class="nm">${esc(c.ref)}</span>
      <span class="meta">${fmt(c.intX)}×${fmt(c.intY)}${c.rot ? ' · ' + fmt1(c.rot) + '°' : ''}</span></div>`).join('') + '</div>';
  box.querySelectorAll('[data-ch]').forEach(el => el.onclick = () => select('chamber', el.dataset.ch));
}

const revitLine = e => e.src === 'revit'
  ? `<br><b>Revit</b> id ${esc(e.revitId != null ? e.revitId : '?')}${e.family ? ' · ' + esc(e.family) : ''}${e.type ? ' : ' + esc(e.type) : ''}${e.revitDoc ? ' · ' + esc(String(e.revitDoc).split(/[\\/]/).pop()) : ''}`
  : '';

function renderChamberProps(box, c){
  if (!c){ box.innerHTML = ''; return; }
  box.innerHTML =
    `<div class="row"><label for="pRef">Reference</label><input type="text" id="pRef" value="${esc(c.ref)}"></div>` +
    cluster('chGeo', 'Geometry', `${fmt(c.intX)}×${fmt(c.intY)} · w${fmt(c.wall)}`,
      numRow('pIX','Internal L (X)', c.intX, 25, 'mm') +
      numRow('pIY','Internal W (Y)', c.intY, 25, 'mm') +
      `<div class="row"><label class="chk"><input type="checkbox" id="pSq" ${state.square?'checked':''}> Keep square</label></div>` +
      numRow('pW','Wall thickness', c.wall, 25, 'mm') +
      numRow('pZL','Lid Z', chamberZs(c)[1], 50, 'mm') +
      numRow('pZB','Base Z', chamberZs(c)[0], 50, 'mm') +
      `<div class="derived">
         <b>External</b> ${fmt(c.intX+2*c.wall)} × ${fmt(c.intY+2*c.wall)} mm<br>
         <b>Internal plan area</b> ${(c.intX*c.intY/1e6).toFixed(2)} m²<br>
         <b>Sides</b> ${FACES.map(f => f+' '+fmt(faceGeom(c,f).width)).join('  ')}${revitLine(c)}</div>`) +
    cluster('chPos', 'Position', `${fmt(c.x)}, ${fmt(c.y)}${c.rot ? ' · ' + fmt1(c.rot) + '°' : ''}${state.lockChambers ? ' · locked' : layerMode(c) === 'static' ? ' · static' : ''}`,
      numRow('pX','Centre X', c.x, state.snap||1, 'mm') +
      numRow('pY','Centre Y', c.y, state.snap||1, 'mm') +
      numRow('pR','Rotation', c.rot, 15, '°')) +
    cluster('chSpc', 'Spacing & clearance', `lat ${fmt(c.latSpace)} · z ${fmt(c.zSpace)} · L0 at ${fmt(chamberZ0(c))}`,
      numRow('pB','Clearance', c.buffer, 50, 'mm') +
      numRow('pLat','Lateral spacing', c.latSpace, 50, 'mm') +
      numRow('pZ','Z spacing', c.zSpace, 50, 'mm') +
      numRow('pZ0','Level 0 Z', chamberZ0(c), 50, 'mm') +
      numRow('pEC','Edge clearance', c.edgeClear ?? 150, 25, 'mm') +
      `<div class="derived"><span>Level 0 Z is the centreline of the top row of conduits; each level below sits one Z spacing lower.</span></div>`) +
    facesBlock(c) +
    `<div class="btnrow"><button id="pDup">Duplicate</button><button id="pDel" class="warn">Delete</button></div>`;
  const bind = (id, key, cast = Number) => {
    const el = document.getElementById(id);
    el.addEventListener('input', () => {
      const v = cast(el.value);
      if (cast === Number && !Number.isFinite(v)) return;
      c[key] = v;
      if (state.square && (key === 'intX' || key === 'intY')){
        const other = key === 'intX' ? 'intY' : 'intX';
        c[other] = v;
        const oel = document.getElementById(key === 'intX' ? 'pIY' : 'pIX');
        if (oel) oel.value = v;
      }
      renderConnections(); draw();
    });
  };
  bind('pRef','ref',String); bind('pIX','intX'); bind('pIY','intY');
  bind('pW','wall'); bind('pZL','zLid'); bind('pZB','zBase'); bind('pX','x'); bind('pY','y'); bind('pR','rot'); bind('pB','buffer');
  bind('pLat','latSpace'); bind('pZ','zSpace'); bind('pZ0','z0'); bind('pEC','edgeClear');
  if (!chamberMovable(c)) for (const id of ['pX', 'pY', 'pR']){ const el = document.getElementById(id); if (el){ el.disabled = true; el.title = state.lockChambers ? 'Locked: only a Revit import moves this manhole' : 'Static layer: it does not move'; } }
  wireFaceButtons(c);
  wireClusters(box, renderSel);
  document.getElementById('pSq').onchange = e => {
    state.square = e.target.checked;
    if (state.square){ c.intY = c.intX; renderSel(); renderConnections(); draw(); }
  };
  document.getElementById('pDup').onclick = () => {
    const n = makeChamber({...c, uid:uid(), ref:nextRef(), x:c.x + c.intX + 2*c.wall + 1000});
    state.chambers.push(n); select('chamber', n.uid);
  };
  document.getElementById('pDel').onclick = () => removeChamber(c.uid);
}

function renderObstacleProps(box, o){
  if (!o){ box.innerHTML = ''; return; }
  box.innerHTML =
    `<div class="row"><label for="oName">Name</label><input type="text" id="oName" value="${esc(o.name)}"></div>` +
    cluster('obGeo', 'Size & position', `${fmt(o.w)}×${fmt(o.d)} at ${fmt(o.x)}, ${fmt(o.y)}`,
      numRow('oW','Width (X)', o.w, 100, 'mm') +
      numRow('oD','Depth (Y)', o.d, 100, 'mm') +
      numRow('oX','Centre X', o.x, state.snap||1, 'mm') +
      numRow('oY','Centre Y', o.y, state.snap||1, 'mm') +
      numRow('oR','Rotation', o.rot, 15, '°') +
      (o.src === 'revit' ? `<div class="derived">${revitLine(o).replace(/^<br>/, '')}</div>` : '')) +
    cluster('obZ', 'Levels & crossing', `${fmt(Math.max(o.zTop, o.zBot))}…${fmt(Math.min(o.zTop, o.zBot))} · ${obsMethod(o)}`,
      numRow('oZT','Top (Z)', o.zTop, 100, 'mm') +
      numRow('oZB','Bottom (Z)', o.zBot, 100, 'mm') +
      `<div class="row"><label for="oMethod">Runs pass it</label>
         <select id="oMethod">${METHODS.map(m => `<option value="${m}" ${obsMethod(o) === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
       <div class="derived"><span>The default for every run — any run can choose differently for this obstacle in its own panel. Around makes the footprint a keep-out; over never rises into the ground cover; a dip under may enter the far chamber lower.</span></div>`) +
    cluster('obClr', 'Clearance', `${fmt(o.buffer)} mm`,
      numRow('oC','Clearance', o.buffer, 50, 'mm') +
      `<div class="derived"><b>Keep-out</b> ${fmt(o.w+2*o.buffer)} × ${fmt(o.d+2*o.buffer)} mm<br>
         <span>Conduits are held off by the larger of this clearance and their own, plus their radius — in plan and in section.</span></div>`) +
    `<div class="btnrow"><button id="oDup">Duplicate</button><button id="oDel" class="warn">Delete</button></div>`;
  const bind = (id, key, cast = Number) => {
    const el = document.getElementById(id);
    el.addEventListener('input', () => {
      const v = cast(el.value);
      if (cast === Number && !Number.isFinite(v)) return;
      o[key] = v; renderObstacles(); renderConnections(); draw();
    });
  };
  bind('oName','name',String); bind('oW','w'); bind('oD','d');
  bind('oX','x'); bind('oY','y'); bind('oR','rot'); bind('oC','buffer'); bind('oZT','zTop'); bind('oZB','zBot');
  document.getElementById('oMethod').onchange = ev => { o.method = ev.target.value; renderSel(); renderObstacles(); renderConnections(); draw(); };
  wireClusters(box, renderSel);
  document.getElementById('oDup').onclick = () => {
    const n = makeObstacle({...o, uid:uid(), name:nextName(), x:o.x + o.w + 1000});
    state.obstacles.push(n); select('obstacle', n.uid);
  };
  document.getElementById('oDel').onclick = () => {
    state.obstacles = state.obstacles.filter(x => x.uid !== o.uid);
    state.sel = null; renderSel(); renderObstacles(); renderConnections(); draw();
  };
}

/** The array as a picture to edit: one circle per conduit, rows stacked as
    they sit with a shorter row against its packed side, seen along the run
    from its first chamber so left is left. A faint slot at the open end of a
    row adds a conduit there, the slot beneath the rows adds a row, and the
    last conduit of a row takes one away. */
const ARRAY_MAX = {cols:12, rows:8};
function arrayEditorSVG(cn, wpx = 262, opt = {}){
  const rows = runRowsOf(cn), cols = Math.max(...rows), side = runAlign(cn), sp = specOf(cn) || {colour:'#888'};
  const nc = Math.min(ARRAY_MAX.cols, cols + 1), nr = Math.min(ARRAY_MAX.rows, rows.length + 1);
  const pitch = Math.max(18, Math.min(36, Math.floor((wpx - 12) / nc))), r = pitch*0.36, pad = 8;
  const W = pad*2 + nc*pitch, H = pad*2 + nr*pitch;
  const xj = j => side === 'left' ? j : j + 1;                    // the spare column sits on the open side
  const cx = j => pad + (j + 0.5)*pitch, cy = i => pad + (i + 0.5)*pitch;
  const f1 = v => v.toFixed(1);
  const el = [`<rect x="0.5" y="0.5" width="${W-1}" height="${H-1}" rx="3" fill="${C.chamber}" stroke="${C.inkFaint}" stroke-width="1" opacity=".9"/>`];
  rows.forEach((n, i) => {
    const start = side === 'left' ? 0 : cols - n;
    for (let k = 0; k < n; k++){
      const j = start + k, last = side === 'left' ? k === n-1 : k === 0;
      el.push(`<circle cx="${f1(cx(xj(j)))}" cy="${f1(cy(i))}" r="${f1(r)}" fill="${sp.colour}" fill-opacity=".35" stroke="${sp.colour}" stroke-width="1.6"${last && !opt.readOnly ? ` data-act="del" data-row="${i}"` : ''}><title>${last && !opt.readOnly ? 'take this conduit away' : `row ${i+1}`}</title></circle>`);
    }
    if (n < ARRAY_MAX.cols && !opt.readOnly){
      const gx = side === 'left' ? n : cols - n;
      el.push(`<circle class="ghost" cx="${f1(cx(gx))}" cy="${f1(cy(i))}" r="${f1(r)}" fill="none" stroke="${C.ink}" stroke-width="1.2" stroke-dasharray="2 2" data-act="add" data-row="${i}"><title>add a conduit to row ${i+1}</title></circle>`);
    }
  });
  if (rows.length < ARRAY_MAX.rows && !opt.readOnly){
    const gx = side === 'left' ? 0 : cols;
    el.push(`<circle class="ghost" cx="${f1(cx(gx))}" cy="${f1(cy(rows.length))}" r="${f1(r)}" fill="none" stroke="${C.ink}" stroke-width="1.2" stroke-dasharray="2 2" data-act="add" data-row="${rows.length}"><title>add a row beneath</title></circle>`);
  }
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${el.join('')}</svg>`;
}

function renderRunProps(box, cn){
  if (!cn){ box.innerHTML = ''; return; }
  const rt = cn.route, sp = specOf(cn), A = byUid(cn.a.mh), B = byUid(cn.b.mh);
  const warns = rt && rt.ok ? rt.warnings : [];
  box.innerHTML =
    `<div class="row"><label style="flex:none" for="qSpec">Conduit spec</label></div>
     <select id="qSpec"${cn.fixed ? ' disabled title="Static: the spec is as the model has it"' : ''}>${state.specs.map(s =>
       `<option value="${s.id}" ${s.id === cn.specId ? 'selected':''}>${esc(s.name)} — Ø${fmt(s.radius*2)} R${fmt(s.bendR)}</option>`).join('')}</select>
     <div style="height:8px"></div>` +
    cluster('runArr', 'Array & level', `${arrayText(cn)} · ${fmt(runSpace(cn))}×${fmt(runZSpace(cn))} · L${cn.level|0}`,
      numRow('qLvl','Level (Z)', cn.level|0, 1, '') +
      numRow('qSpX','Spacing across', runSpace(cn), 25, 'mm') +
      numRow('qSpZ','Spacing down', runZSpace(cn), 25, 'mm') +
      `<div class="derived" style="margin-top:0"><span>The centres this run is laid on, set here or where they live: across on the spec (${esc(sp.name)}, in the Specs window), down on the manholes (their Z spacing, in the Chambers window). A face is laid on the largest across-spacing of the runs it carries, so they share one grid.</span></div>` +
      `<div class="row" style="margin-bottom:4px"><label>Array — the section of the run, seen along it from ${esc(A ? A.ref : '?')} to ${esc(B ? B.ref : '?')}</label></div>
       <div class="arrayed" id="qArray">${arrayEditorSVG(cn, 262, {readOnly: !!cn.fixed})}</div>
       <div class="derived" style="border-top:none;margin-top:0;padding-top:0"><b>${arrayText(cn)}</b> · ${runCount(cn)} conduit${runCount(cn) === 1 ? '' : 's'} · ${runCols(cn)} wide × ${runRows(cn)} high${new Set(runRowsOf(cn)).size > 1 ? ` · shorter rows on the ${runAlign(cn)}` : ''}<br>
         <span>${cn.fixed ? 'Static: the array is as the model has it.' : 'Click a dotted slot to add a conduit to that row, the slot beneath to add a row, or the last conduit of a row to take it away. Rows share one set of columns, so the conduits line up vertically.'}</span></div>` +
      (new Set(runRowsOf(cn)).size > 1 && !cn.fixed
        ? `<div class="row"><label for="qAlign">Shorter rows sit</label>
             <select id="qAlign">${ALIGNS.map(a => `<option value="${a}"${runAlignPref(cn) === a ? ' selected' : ''}>${a === 'auto' ? `auto — ${runAlign(cn)}` : a}</option>`).join('')}</select></div>
           <div class="derived"><span>Auto takes the side the next manhole lies on, or the side away from the face's other runs when it lies straight ahead.</span></div>`
        : '')) +
    cluster('runObs', 'Obstacles', obsSummary(cn),
      state.obstacles.length ? state.obstacles.map(o => {
        const chosen = cn.cross && METHODS.includes(cn.cross[o.uid]) ? cn.cross[o.uid] : '';
        const x = rt && rt.ok ? (rt.crossings || []).find(k => k.uid === o.uid) : null;
        const status = !rt || !rt.ok ? '' : x ? `${x.mode} · Z ${fmt(x.z)}` : (runMethod(cn, o) === 'around' ? 'kept clear' : 'not met');
        return `<div class="row"><label for="qObs-${o.uid}">${esc(o.name)}</label>
          <select id="qObs-${o.uid}" data-obs="${o.uid}">
            <option value=""${chosen ? '' : ' selected'}>default — ${obsMethod(o)}</option>
            ${METHODS.map(m => `<option value="${m}"${chosen === m ? ' selected' : ''}>${m}</option>`).join('')}
          </select></div>
          <div class="row" style="margin-top:-4px"><label></label><span class="unit" style="width:auto;text-align:right;flex:1">${esc(status)}</span></div>`;
      }).join('') + `<div class="derived"><span>How this run passes each obstacle. Runs sharing these two faces travel as one bank and follow the majority.</span></div>`
      : `<div class="empty">No obstacles on the drawing.</div>`) +
    cluster('runRt', 'Route',
      rt && rt.ok ? metres(rt.length3d || rt.length) + (rt.fixed ? ' · static' : (rt.turns.length ? ` · ${rt.turns.length} bend${rt.turns.length === 1 ? '' : 's'}` : ' · straight')
                    + (rt.profile && rt.profile.turns.length ? ` + ${rt.profile.turns.length} vertical` : '')) : 'no route',
      `<div class="derived" style="border-top:none;margin-top:0;padding-top:2px">
         <b>Run</b> ${esc(connLabel(cn))}<br>
         ${entryLine(cn)}${arrayLine(cn)}${encLine(cn)}` +
         (rt && rt.ok && rt.fixed
           ? `<b>Static</b> on the layer ${esc(layerOf(cn).name)} — it is never re-routed, and other runs keep clear of it<br>
              <b>Centreline</b> ${metres(rt.length)} in plan · ${metres(rt.length3d || rt.length)} laid · ${rt.pts.length} points`
           : `<b>Angles</b> ${sp.angles.length ? sp.angles.map(a => fmt1(a)+'°').join(' · ') : 'straight only'}<br>` +
             (rt && rt.ok
               ? `<b>Bends</b> ${rt.turns.length ? rt.turns.map(t => fmt1(Math.abs(t))+'°' + (isCustomTurn(t, sp.angles) ? ' custom' : '')).join(' · ') : 'none — straight run'}<br>
                  <b>Straight duct</b> ${rt.clear.map(v => fmt(Math.max(0,v))).join(' · ')} mm<br>
                  <b>Centreline</b> ${metres(rt.length)} in plan${rt.profile && rt.profile.turns.length ? ` · ${metres(rt.length3d)} laid` : ''}` +
                 sectionLines(rt)
               : `<span style="color:${C.bad}">${esc(rt ? rt.msg : '')}</span>`)) +
      `</div>`) +
    cluster('runSec', 'Long section', sectionSummary(rt), profileSVG(cn, 232)) +
    (warns.length ? `<div class="alert warn"><b>Check this run</b>${warns.map(w => esc(w.text)).join('<br>')}</div>` : '') +
    (rt && !rt.ok ? `<div class="alert bad"><b>Cannot place</b>${esc(rt.msg)}</div>` : '') +
    `<div class="btnrow">
       ${cn.fixed ? '' : `<button id="qPlace" class="primary" ${rt && rt.ok ? '' : 'disabled'}>${cn.placed ? 'Update line' : 'Place line'}</button>`}
       <button id="qDrop" class="warn">Disconnect</button></div>` +
    (cn.placed ? '' : `<div class="note">Not placed yet — the dashed guide shows the face pair.</div>`) +
    `<div class="btnrow"><button id="qEditSpec" class="ghost mini">Edit “${esc(sp.name)}” on the left</button></div>`;

  for (const [id, set] of [['qSpX', v => { sp.spacing = v; }],
                           ['qSpZ', v => { for (const u of [cn.a.mh, cn.b.mh]){ const c = byUid(u); if (c) c.zSpace = v; } }]]){
    const el = document.getElementById(id);
    if (cn.fixed){ el.disabled = true; el.title = 'Static: the spacing is as the model has it'; continue; }
    el.addEventListener('input', () => {
      const v = Number(el.value);
      if (!Number.isFinite(v) || v <= 0) return;
      set(Math.round(v));                       // the spec's own spacing, or the two manholes' — the same values their windows hold
      bankCache.clear(); recomputeRoutes();
      const head = box.querySelector('[data-clus="runArr"] em');      // the summary keeps up without rebuilding the fields under the cursor
      if (head) head.textContent = `${arrayText(cn)} · ${fmt(runSpace(cn))}×${fmt(runZSpace(cn))} · L${cn.level|0}`;
      renderSpecs(); draw();
    });
  }
  const lvlEl = document.getElementById('qLvl');
  if (cn.fixed){ lvlEl.disabled = true; lvlEl.title = 'Static: the depth is as the model has it'; }
  lvlEl.addEventListener('input', () => {
    const v = Math.max(0, Math.round(Number(lvlEl.value)||0));
    cn.level = v;
    renderSel(); renderConnections(); draw();
  });
  box.querySelectorAll('#qArray [data-act]').forEach(k => k.addEventListener('click', e => {
    e.stopPropagation();
    const v = runRowsOf(cn), i = +k.dataset.row;
    if (k.dataset.act === 'add'){ if (i >= v.length) v.push(1); else v[i] = Math.min(ARRAY_MAX.cols, v[i] + 1); }
    else if (v[i] > 1) v[i]--;
    else if (v.length > 1) v.splice(i, 1);
    else return;
    cn.perRow = v; delete cn.rows; delete cn.cols;
    renderSel(); renderConnections(); draw();
  }));
  const alEl = document.getElementById('qAlign');
  if (alEl) alEl.onchange = e => { cn.align = e.target.value; renderSel(); renderConnections(); draw(); };
  document.getElementById('qSpec').onchange = e => {
    cn.specId = e.target.value;
    state.editSpec = cn.specId;
    renderSpecs(); renderSpecEdit(); renderSel(); renderConnections(); draw();
  };
  const placeBtn = document.getElementById('qPlace');
  if (placeBtn) placeBtn.onclick = () => { cn.placed = true; renderSel(); renderConnections(); draw(); };
  document.getElementById('qDrop').onclick = () => disconnect(cn.uid);
  box.querySelectorAll('[data-obs]').forEach(el => el.onchange = () => {
    cn.cross = cn.cross || {};
    if (el.value) cn.cross[el.dataset.obs] = el.value; else delete cn.cross[el.dataset.obs];
    renderSel(); renderConnections(); draw();
  });
  document.getElementById('qEditSpec').onclick = () => {
    state.editSpec = cn.specId; renderSpecs(); renderSpecEdit();
    openWin('specs');
  };
  wireClusters(box, renderSel);
}

/** Cross-section of one chamber face: the shared conduit grid to scale,
    every conduit as a circle in its spec colour, edge-clearance guides,
    and a caption saying whether the face carries it. */
/** The elevation of one face at true scale: the whole face from lid to base, the
    boundary box its conduits must keep to (the family's conduit window, else the
    clear area inside the edge clearance) dotted, each level's line and depth, and
    every conduit at its own depth and lateral offset. With `sel` each conduit
    carries its run and the selected run is lit; with `responsive` the drawing
    scales to its window. */
function faceSectionSVG(L, wpx = 232, opt = {}){
  const c = L.c, ec = c.edgeClear || 0, W = L.g.width, S = L.S;
  const [zb, zl] = chamberZs(c), Hf = Math.max(1, zl - zb);
  const z0 = chamberZ0(c), zp = Math.max(1, c.zSpace || 300);
  const pad = 12, RM = 48, scale = (wpx - pad*2) / W;   // a margin on the right carries the level depths
  const hpx = Hf*scale + pad*2 + 16;
  const X = mm => pad + (mm + W/2)*scale;           // lateral offset from the face centre
  const Y = z => pad + (zl - z)*scale;              // depth, lid at the top
  const f1 = v => v.toFixed(1);
  const el = [];
  el.push(`<rect x="${f1(X(-W/2))}" y="${f1(Y(zl))}" width="${f1(W*scale)}" height="${f1(Hf*scale)}" fill="none" stroke="${C.inkFaint}" stroke-width="1"/>`);
  const win = L.win;
  const bx0 = win ? X(L.shift - win.w/2) : X(-(W/2-ec)), bx1 = win ? X(L.shift + win.w/2) : X(W/2-ec);
  const bzt = Math.min(zl, win ? z0 + zp/2 : zl - ec);                                   // the top row sits half a pitch below a window's top
  const bzbot = Math.max(zb, win ? (win.h ? bzt - win.h : zb + ec) : zb + ec);
  el.push(`<rect x="${f1(bx0)}" y="${f1(Y(bzt))}" width="${f1(bx1-bx0)}" height="${f1(Math.max(0, Y(bzbot)-Y(bzt)))}" fill="none" stroke="${C.pick}" stroke-width="1.2" stroke-dasharray="2 3" opacity=".9"/>`);
  el.push(`<text x="${f1(X(-W/2)+4)}" y="${f1(Y(zl)+10)}" fill="${C.inkFaint}" font-family="${C.mono}" font-size="8.5">lid ${fmt(zl)}</text>`);
  el.push(`<text x="${f1(X(-W/2)+4)}" y="${f1(Y(zb)-4)}" fill="${C.inkFaint}" font-family="${C.mono}" font-size="8.5">base ${fmt(zb)}</text>`);
  for (const lv of [...new Set(L.groups.map(g => g.level))]){
    const z = z0 - lv*zp;
    el.push(`<line x1="${f1(X(-W/2))}" y1="${f1(Y(z))}" x2="${f1(X(W/2))}" y2="${f1(Y(z))}" stroke="${C.inkFaint}" stroke-width="1" stroke-dasharray="1 4" opacity=".6"/>`);
    el.push(`<text x="${f1(X(W/2)+5)}" y="${f1(Y(z)+3)}" fill="${C.inkFaint}" font-family="${C.mono}" font-size="8.5">L${lv} ${fmt(z)}</text>`);
  }
  for (const gr of L.groups) for (const it of gr.items){
    if (!it.sp) continue;
    const on = !!opt.sel && inSel('conn', it.cn.uid);
    const A = byUid(it.cn.a.mh), B = byUid(it.cn.b.mh);
    const zr = runZSpace(it.cn);                                      // the run's row pitch, as the 3D view lays it
    const rp = Math.max(2.2, it.sp.radius*scale);
    const end = (it.cn.a.mh === c.uid && it.cn.a.face === L.g.face) ? 'a' : 'b', sgn = leftSign(it.cn, end, L.g, L.t), RC = rowColumns(it.cn);
    const E = showEnc(it.cn) ? runEncasement(it.cn) : null;
    if (E){
      const zt = z0 - gr.level*zr + E.zTop, zb2 = z0 - gr.level*zr + E.zBot;
      el.push(`<rect x="${f1(X(it.centreOff - E.halfW))}" y="${f1(Y(zt))}" width="${f1(E.W*scale)}" height="${f1(Math.max(0, Y(zb2) - Y(zt)))}" fill="${it.sp.colour}" fill-opacity=".08" stroke="${on ? C.sel : it.sp.colour}" stroke-width="1" stroke-dasharray="4 3" opacity=".8"/>`);
    }
    for (let rI = 0; rI < RC.length; rI++) for (const off of RC[rI]){
      const xo = it.centreOff + sgn*off*S, z = z0 - gr.level*zr - rI*zr;
      el.push(`<circle cx="${f1(X(xo))}" cy="${f1(Y(z))}" r="${f1(rp)}" fill="${on ? C.sel : 'none'}" fill-opacity="${on ? .25 : 0}" stroke="${on ? C.sel : it.sp.colour}" stroke-width="${on ? 2.2 : 1.6}"${opt.sel ? ` data-sel="${it.cn.uid}"` : ''}/>`);
    }
  }
  const cap = !L.groups.length
    ? (win ? `window ${fmt(win.w)}${win.h ? '×' + fmt(win.h) : ''} · no runs` : `clear ${fmt(W - 2*ec)} of ${fmt(W)} · no runs`)
    : win
      ? `pitch ${fmt(S)} · window ${fmt(win.w)}${win.h ? '×' + fmt(win.h) : ''} · grid ${fmt(L.usedW)} ${L.fits ? '✓' : '✗ OVER'}`
      : `pitch ${fmt(S)} · edge ≥${fmt(ec)} · grid ${fmt(L.usedW)} / face ${fmt(W)} ${L.fits ? '✓' : '✗ OVER'}`;
  el.push(`<text x="${wpx/2}" y="${hpx-4}" fill="${L.fits ? C.inkFaint : C.bad}" font-family="${C.mono}" font-size="9.5" text-anchor="middle">${cap}</text>`);
  const size = opt.responsive ? `viewBox="0 0 ${wpx+RM} ${f1(hpx)}" width="100%"` : `width="${wpx+RM}" height="${f1(hpx)}"`;
  return `<svg ${size} style="display:block;margin:4px 0 2px">${el.join('')}</svg>`;
}

/** One compact button per side — the detail lives in the side dialog. */
function facesBlock(c){
  const btns = FACES.map(f => {
    const n = faceRuns(c.uid, f).length;
    const nm = c.sides && c.sides[f] ? ' ' + esc(c.sides[f]) : '';
    if (!n) return `<button class="facebtn off" disabled title="side ${f}${nm} — no runs">${f}${nm}</button>`;
    const L = faceLayout(c.uid, f);
    return `<button class="facebtn${L.fits ? '' : ' bad'}" data-fdlg="${f}"
      title="side ${f}${nm} — ${n} run${n === 1 ? '' : 's'}${L.fits ? '' : ', too narrow'}">${f}${nm} · ${n}${L.fits ? '' : ' ⚠'}</button>`;
  });
  return `<div class="row" style="margin:12px 0 2px"><label>Side settings</label></div>
    <div class="btnrow" style="margin-top:2px">${btns.join('')}</div>`;
}

function wireFaceButtons(c){
  document.querySelectorAll('[data-fdlg]').forEach(b => {
    b.onclick = () => openFaceDialog(c.uid, b.dataset.fdlg);
  });
}

/* ---------- the elevation window: one face at a time ---------- */

function openFaceDialog(mh, face){ openElevation(mh, face); }
/** Show a face in the Elevation window; asking for another face replaces it. */
function openElevation(mh, face){ state.elev = {mh, face}; openWin('elevation'); renderElevation(); }
function closeElevation(){ closeWin('elevation'); }

/** The face's runs with their stacking controls, and the to-scale section
    through the face with its boundary box; a conduit or a row selects its run. */
function renderElevation(){
  const box = document.getElementById('elevBody'), who = document.getElementById('elevWho');
  const ev = state.elev, c = ev && byUid(ev.mh);
  if (!c){
    state.elev = null; who.textContent = '';
    box.innerHTML = `<div class="empty">Right-click a face on the plan and choose <b>Elevation</b>, or press a side button in the Chambers window.</div>`;
    return;
  }
  const L = faceLayout(ev.mh, ev.face), n = faceRuns(ev.mh, ev.face).length;
  who.textContent = `${c.ref} · side ${ev.face}${c.sides && c.sides[ev.face] ? ' (' + c.sides[ev.face] + ')' : ''}`;
  const rows = L.groups.flatMap(gr => gr.items.map(it => {
    const sp = it.sp || {colour:'#888', name:'?'};
    return `<div class="dlgrow${inSel('conn', it.cn.uid) ? ' on' : ''}" data-elsel="${it.cn.uid}">
      <span class="dot" style="background:${sp.colour}"></span>
      <span class="nm">${esc(connLabel(it.cn))} · ${esc(sp.name)} ${esc(arrayText(it.cn))}</span>
      <em>L${gr.level}${it.cn.fixed ? ' · static' : ''}</em>
      ${it.cn.fixed ? '' : `<button data-fup="${it.cn.uid}" title="raise (smaller level)">▲</button>
      <button data-fdn="${it.cn.uid}" title="lower (bigger level)">▼</button>`}</div>`;
  }));
  box.innerHTML = `<div class="note" style="margin:0 0 8px">${n
      ? `${n} run${n === 1 ? '' : 's'} on this side${L.fits ? '' : ' — too narrow'} · click a conduit to select its run`
      : 'No runs on this side yet. The dotted box is where conduits may enter.'}</div>` +
    rows.join('') + faceSectionSVG(L, 288, {responsive:true, sel:true});
  box.querySelectorAll('[data-fup],[data-fdn]').forEach(b => {
    b.onclick = e => {
      e.stopPropagation();
      const up = b.hasAttribute('data-fup');
      const cn = state.connections.find(x => x.uid === b.getAttribute(up ? 'data-fup' : 'data-fdn'));
      if (!cn) return;
      cn.level = Math.max(0, (cn.level|0) + (up ? -1 : 1));
      recomputeRoutes();
      renderSel(); renderConnections(); draw();
    };
  });
  box.querySelectorAll('[data-elsel]').forEach(r => r.onclick = () => select('conn', r.dataset.elsel));
  box.querySelectorAll('svg [data-sel]').forEach(k => k.addEventListener('click', e => { e.stopPropagation(); select('conn', k.dataset.sel); }));
}

function obsSummary(cn){
  const ov = state.obstacles.filter(o => cn.cross && METHODS.includes(cn.cross[o.uid])).map(o => `${cn.cross[o.uid]} ${o.name}`);
  return ov.length ? ov.join(' · ') : (state.obstacles.length ? 'defaults' : 'none');
}
function sectionSummary(rt){
  if (!rt || !rt.ok || !rt.profile) return '—';
  const pf = rt.profile, xs = rt.crossings || [];
  if (xs.length) return xs.map(x => `${x.mode} ${x.name}`).join(' · ');
  return pf.turns.length ? `${pf.turns.length} vertical bend${pf.turns.length === 1 ? '' : 's'}` : 'level';
}
function sectionLines(rt){
  const pf = rt.profile;
  if (!pf) return '';
  let s = `<br><b>In section</b> ${pf.turns.length ? pf.turns.map(t => fmt1(Math.abs(t))+'°').join(' · ') : 'no vertical bends'}`;
  const xs = rt.crossings || [];
  if (xs.length)
    s += `<br><b>Crossings</b> ${xs.map(x => `${x.mode} ${esc(x.name)} at Z ${fmt(x.z)}`).join(' · ')}`;
  return s;
}
/** Long section of one run: chainage across, Z up (exaggerated, and the
    caption says by how much), the crossed obstacles as boxes, the conduit
    in its spec colour at its own radius. */
function profileSVG(cn, wpx = 232){
  const rt = cn.route, pf = rt && rt.ok ? rt.profile : null;
  if (!pf) return `<div class="empty">No section — the run has no route.</div>`;
  const sp = specOf(cn), A = byUid(cn.a.mh), B = byUid(cn.b.mh), S = pf.S, r = sp.radius;
  let zMin = Math.min(...pf.poly.map(p => p[1])) - r, zMax = Math.max(...pf.poly.map(p => p[1])) + r;
  for (const x of pf.crossings){ zMin = Math.min(zMin, x.zBot); zMax = Math.max(zMax, x.zTop); }
  zMin -= 150; zMax += 380;                       // headroom for the chamber names and depths
  const pad = 12, capH = 16;
  const sx = (wpx - pad*2) / Math.max(1, S);
  const sz = Math.min(sx*4, 126 / Math.max(1, zMax - zMin));
  const hpx = Math.round((zMax - zMin)*sz + pad*2);
  const X = s => pad + s*sx, Y = z => pad + (zMax - z)*sz;
  const el = [];
  zMax = Math.max(zMax, state.ground + 60);
  el.push(`<line x1="${pad}" y1="${Y(state.ground).toFixed(1)}" x2="${wpx-pad}" y2="${Y(state.ground).toFixed(1)}" stroke="${C.inkFaint}" stroke-width="1" stroke-dasharray="3 3" opacity=".7"/>`);
  for (const x of pf.crossings){
    el.push(`<rect x="${X(x.s0).toFixed(1)}" y="${Y(x.zTop).toFixed(1)}" width="${Math.max(1, (x.s1-x.s0)*sx).toFixed(1)}" height="${Math.max(1, (x.zTop-x.zBot)*sz).toFixed(1)}" fill="${C.obsFill}" stroke="${C.obsLine}" stroke-width="1"/>`);
    el.push(`<text x="${X((x.s0+x.s1)/2).toFixed(1)}" y="${(Y(x.zTop)-3).toFixed(1)}" fill="${C.obsLine}" font-family="${C.mono}" font-size="9" text-anchor="middle">${esc(x.name)}</text>`);
  }
  for (const [s, ref, z, anchor, dx] of [[0, A ? A.ref : '?', pf.zA, 'start', 3], [S, B ? B.ref : '?', pf.zB, 'end', -3]]){
    el.push(`<line x1="${X(s).toFixed(1)}" y1="${pad}" x2="${X(s).toFixed(1)}" y2="${hpx-pad}" stroke="${C.ink}" stroke-width="1.2"/>`);
    el.push(`<text x="${(X(s)+dx).toFixed(1)}" y="${pad+9}" fill="${C.ink}" font-family="${C.mono}" font-size="9.5" text-anchor="${anchor}">${esc(ref)}</text>`);
    el.push(`<text x="${(X(s)+dx).toFixed(1)}" y="${pad+20}" fill="${C.inkDim}" font-family="${C.mono}" font-size="9" text-anchor="${anchor}">Z ${fmt(z)}</text>`);
  }
  const d = pf.poly.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join(' ');
  el.push(`<path d="${d}" fill="none" stroke="${sp.colour}" stroke-width="${Math.max(2, 2*r*sz).toFixed(1)}" stroke-linejoin="round" opacity=".95"/>`);
  const zLow = Math.min(...pf.poly.map(p => p[1])), zHigh = Math.max(...pf.poly.map(p => p[1]));
  const low = pf.poly.find(p => p[1] === zLow), high = pf.poly.find(p => p[1] === zHigh);
  if (high && zHigh > Math.max(pf.zA, pf.zB) + 1)
    el.push(`<text x="${X(high[0]).toFixed(1)}" y="${(Y(zHigh)-r*sz-4).toFixed(1)}" fill="${C.inkDim}" font-family="${C.mono}" font-size="9" text-anchor="middle">Z ${fmt(zHigh)}</text>`);
  if (low && zLow < Math.min(pf.zA, pf.zB) - 1)
    el.push(`<text x="${X(low[0]).toFixed(1)}" y="${(Y(zLow)+r*sz+11).toFixed(1)}" fill="${C.inkDim}" font-family="${C.mono}" font-size="9" text-anchor="middle">Z ${fmt(zLow)}</text>`);
  const cap = `${metres(rt.length3d || rt.length)} laid · ${pf.turns.length ? pf.turns.length + ' vertical bend' + (pf.turns.length === 1 ? '' : 's') : 'no vertical bends'} · Z ×${(sz/sx).toFixed(1)}`;
  el.push(`<text x="${wpx/2}" y="${hpx+capH-4}" fill="${C.inkFaint}" font-family="${C.mono}" font-size="9.5" text-anchor="middle">${cap}</text>`);
  return `<svg width="${wpx}" height="${hpx+capH}" style="display:block;margin:4px 0 2px">${el.join('')}</svg>`;
}
function encLine(cn){
  const E = runEncasement(cn);
  return E ? `<b>Encasement</b> ${fmt(E.W)} wide × ${fmt(E.H)} high, ${fmt(E.off)} beyond the conduits<br>` : '';
}
function arrayLine(cn){
  const ea = entryFor(cn,'a'), eb = entryFor(cn,'b');
  const S = Math.max(ea ? ea.S||0 : 0, eb ? eb.S||0 : 0);
  const rows = runRowsOf(cn);
  if (rows.length === 1 && rows[0] === 1) return '';
  const A = byUid(cn.a.mh), B = byUid(cn.b.mh);
  const packed = new Set(rows).size > 1 ? `, short rows to the ${runAlign(cn)} along ${esc(A ? A.ref : '?')} → ${esc(B ? B.ref : '?')}` : '';
  return `<b>Array</b> ${rows.join(' + ')} — ${runCount(cn)} conduits at ${fmt(S)} across${rows.length > 1 ? ` × ${fmt(runZSpace(cn))} down` : ''}${packed}<br>`;
}
function entryLine(cn){
  const A = byUid(cn.a.mh), B = byUid(cn.b.mh);
  const ea = entryFor(cn,'a'), eb = entryFor(cn,'b');
  if (!A || !B || !ea || !eb) return '';
  const lvl = cn.level|0;
  const side = o => o === 0 ? 'centre' : (o > 0 ? '+' : '−') + fmt(Math.abs(o));
  let line = `<b>Entry</b> ${side(ea.offset)} at ${esc(A.ref)} · ${side(eb.offset)} at ${esc(B.ref)}`;
  const pf = cn.route && cn.route.ok ? cn.route.profile : null;
  const za = pf ? pf.zA : chamberZ0(A) - lvl*A.zSpace, zb = pf ? pf.zB : chamberZ0(B) - lvl*B.zSpace;
  line += `<br><b>Depth</b> Z ${fmt(za)} at ${esc(A.ref)} · Z ${fmt(zb)} at ${esc(B.ref)}${lvl ? ` (level ${lvl})` : ''}`;
  return line + '<br>';
}

function removeChamber(u){
  state.chambers = state.chambers.filter(c => c.uid !== u);
  state.connections = state.connections.filter(c => c.a.mh !== u && c.b.mh !== u);
  state.sel = null; state.pending = null;
  renderSel(); renderConnections(); draw();
}

/* ==========================================================================
   CONTROLS
   ========================================================================== */

const viewCentre = () => {
  const r = STAGE.getBoundingClientRect();
  return S2W([r.width/2, r.height/2]);
};

document.getElementById('btnAdd').onclick = () => {
  const p = viewCentre(), base = state.chambers[state.chambers.length-1];
  const c = makeChamber({x:snap(p[0]), y:snap(p[1]), layer: activeLayerId(),
    intX: base?base.intX:1200, intY: base?base.intY:1200, wall: base?base.wall:150});
  state.chambers.push(c); select('chamber', c.uid);
};
document.getElementById('btnObs').onclick = () => {
  const p = viewCentre();
  const o = makeObstacle({x:snap(p[0]), y:snap(p[1]), layer: activeLayerId()});
  state.obstacles.push(o); select('obstacle', o.uid);
};
document.getElementById('btnFit').onclick = () => fitView();

/* ---------- Encase: the selected runs, or every run, in their specs' encasement ---------- */
document.getElementById('btnEncase').onclick = () => {
  const selRuns = new Set(state.selSet.filter(x => x.kind === 'conn').map(x => x.id));
  const selCh = new Set(state.selSet.filter(x => x.kind === 'chamber').map(x => x.id));
  let targets = state.connections.filter(cn => selRuns.has(cn.uid) || selCh.has(cn.a.mh) || selCh.has(cn.b.mh));
  const all = !targets.length;
  if (all) targets = state.connections.slice();
  if (!targets.length){ exStatus('nothing to encase — draw a run first'); return; }
  const allOn = targets.every(cn => cn.encased);
  const given = new Set();
  for (const cn of targets){
    cn.encased = !allOn;
    if (!allOn){ const sp = specOf(cn); if (sp && !encOf(sp)){ sp.enc = 100; given.add(sp.name); } }
  }
  const n = targets.length, s = n === 1 ? '' : 's';
  bankCache.clear(); renderSpecs(); renderSpecEdit(); renderSel(); renderConnections(); draw();
  exStatus(allOn ? `encasement taken off ${n} run${s}`
    : `${n} run${s} encased${all ? ' — every run on the drawing' : ''}${given.size ? ` · ${[...given].join(', ')} given a 100 mm encasement offset` : ''}`);
};

/* ---------- Layers: like Revit worksets ---------- */
function renderLayers(){
  const box = document.getElementById('layerList');
  if (!box) return;
  const idOf = e => layerById(e.layer) ? e.layer : DEFAULT_LAYER;
  const count = (arr, id) => arr.filter(e => idOf(e) === id).length;
  const cnt = document.getElementById('layerCount'); if (cnt) cnt.textContent = state.layers.length > 1 ? state.layers.length : '';
  box.innerHTML = state.layers.map(l => {
    const nc = count(state.chambers, l.id), nr = count(state.connections, l.id), no = count(state.obstacles, l.id);
    const pending = state.connections.filter(cn => idOf(cn) === l.id && ((l.mode === 'static') !== !!(cn.fixed && cn.fixedPath))).length;
    const mode = l.mode === 'static' ? 'static' : 'dynamic';
    return `<div class="layer${l.id === activeLayerId() ? ' on' : ''}" data-layer="${l.id}">
      <div class="lrow"><input type="radio" name="activeLayer" data-lact="${l.id}"${l.id === activeLayerId() ? ' checked' : ''} title="New chambers, runs and obstacles go to the active layer">
        <input type="text" class="lname" data-lname="${l.id}" value="${esc(l.name)}" title="The layer's name">
        <label class="chk" title="Show or hide the layer on the drawing"><input type="checkbox" data-lvis="${l.id}"${l.visible !== false ? ' checked' : ''}> shown</label></div>
      <div class="lrow"><span class="meta">${nc} chamber${nc === 1 ? '' : 's'} · ${nr} run${nr === 1 ? '' : 's'} · ${no} obstacle${no === 1 ? '' : 's'}${pending ? ` · <b>${pending} to update</b>` : ''}</span>
        <select class="mini" data-lmode="${l.id}" title="${esc(MODE_NOTE[mode])}">${['dynamic','static'].map(k => `<option value="${k}"${mode === k ? ' selected' : ''}>${k}</option>`).join('')}</select>
        <button class="mini" data-lmove="${l.id}" title="Move the selected chambers, runs and obstacles to this layer">Move selection here</button>
        ${l.id === DEFAULT_LAYER ? '' : `<button class="mini x" data-ldel="${l.id}" title="Delete the layer — what is on it goes to the Drawing layer">×</button>`}</div></div>`;
  }).join('');
  const who = document.getElementById('layerWho'); if (who) who.textContent = `${state.layers.length} layer${state.layers.length === 1 ? '' : 's'}`;
  renderModels();
  box.querySelectorAll('[data-lact]').forEach(el => el.onchange = () => { state.activeLayer = el.dataset.lact; renderLayers(); });
  box.querySelectorAll('[data-lname]').forEach(el => el.addEventListener('input', () => { const l = layerById(el.dataset.lname); if (l) l.name = el.value; }));
  box.querySelectorAll('[data-lvis]').forEach(el => el.onchange = () => { const l = layerById(el.dataset.lvis); if (l){ l.visible = el.checked; } renderSel(); draw(); });
  box.querySelectorAll('[data-lmode]').forEach(el => el.onchange = () => {
    const l = layerById(el.dataset.lmode); if (!l) return;
    l.mode = el.value === 'static' ? 'static' : 'dynamic';
    renderSel(); renderLayers(); draw();
    exStatus(`${l.name} is now ${l.mode} — its manholes ${l.mode === 'static' ? 'stay put' : 'can move'}; press Update routes to ${l.mode === 'static' ? 'fix its runs as they stand' : 'route its runs again with avoidance'}`);
  });
  box.querySelectorAll('[data-lmove]').forEach(el => el.onclick = () => {
    const id = el.dataset.lmove; let n = 0;
    for (const x of state.selSet){
      const e = x.kind === 'chamber' ? byUid(x.id) : x.kind === 'obstacle' ? obsBy(x.id) : x.kind === 'conn' ? connBy(x.id) : null;
      if (e && e.layer !== id){ e.layer = id; n++; }
    }
    renderSel(); renderConnections(); renderLayers(); draw();
    exStatus(n ? `${n} element${n === 1 ? '' : 's'} moved to ${layerById(id).name}` : 'select something on the drawing first');
  });
  box.querySelectorAll('[data-ldel]').forEach(el => el.onclick = () => {
    const id = el.dataset.ldel, l = layerById(id); if (!l || id === DEFAULT_LAYER) return;
    for (const e of [...state.chambers, ...state.obstacles, ...state.connections]) if (e.layer === id) e.layer = DEFAULT_LAYER;
    state.layers = state.layers.filter(x => x.id !== id);
    if (state.activeLayer === id) state.activeLayer = DEFAULT_LAYER;
    renderSel(); renderConnections(); renderLayers(); draw();
  });
}
/** Models: every layer as a model — show or hide it, or only its manholes, conduits, encasement or obstacles, and select all of it. */
function renderModels(){
  const box = document.getElementById('modelList');
  if (!box) return;
  const idOf = e => layerById(e.layer) ? e.layer : DEFAULT_LAYER;
  const KINDS = [['chambers', 'manholes'], ['runs', 'conduits'], ['encasement', 'encasement'], ['obstacles', 'obstacles']];
  box.innerHTML = state.layers.map(l => {
    const nc = state.chambers.filter(e => idOf(e) === l.id).length, nr = state.connections.filter(e => idOf(e) === l.id).length;
    const ne = state.connections.filter(e => idOf(e) === l.id && e.encased).length, no = state.obstacles.filter(e => idOf(e) === l.id).length;
    const sh = l.show || {}, off = l.visible === false;
    return `<div class="layer${off ? ' off' : ''}" data-model="${l.id}">
      <div class="lrow"><label class="chk" style="flex:1"><input type="checkbox" data-mvis="${l.id}"${off ? '' : ' checked'}> <b>${esc(l.name)}</b></label>
        <button class="mini" data-msel="${l.id}" title="Select everything shown on this model">Select</button></div>
      <div class="lrow"><span class="meta">${l.mode === 'static' ? 'static' : 'dynamic'} · ${nc} manhole${nc === 1 ? '' : 's'} · ${nr} conduit run${nr === 1 ? '' : 's'}, ${ne} encased · ${no} obstacle${no === 1 ? '' : 's'}</span></div>
      <div class="lrow">${KINDS.map(([k, nm]) => `<label class="chk"><input type="checkbox" data-mkind="${l.id}:${k}"${sh[k] !== false ? ' checked' : ''}${off ? ' disabled' : ''}> ${nm}</label>`).join('')}</div></div>`;
  }).join('');
  const who = document.getElementById('modelWho'); if (who) who.textContent = `${state.layers.length} model${state.layers.length === 1 ? '' : 's'}`;
  box.querySelectorAll('[data-mvis]').forEach(el => el.onchange = () => { const l = layerById(el.dataset.mvis); if (l) l.visible = el.checked; renderLayers(); renderSel(); draw(); });
  box.querySelectorAll('[data-mkind]').forEach(el => el.onchange = () => {
    const [id, k] = el.dataset.mkind.split(':'), l = layerById(id); if (!l) return;
    l.show = {...(l.show || {}), [k]: el.checked}; renderSel(); draw();
  });
  box.querySelectorAll('[data-msel]').forEach(el => el.onclick = () => {
    const id = el.dataset.msel, l = layerById(id); if (!l) return;
    const set = [...state.chambers.filter(e => idOf(e) === id && isVisible(e)).map(e => ({kind:'chamber', id:e.uid})),
                 ...state.obstacles.filter(e => idOf(e) === id && isVisible(e)).map(e => ({kind:'obstacle', id:e.uid})),
                 ...state.connections.filter(e => idOf(e) === id && isVisible(e)).map(e => ({kind:'conn', id:e.uid}))];
    state.selSet = set; state.sel = set[0] || null; state.pending = null; setPendingStatus();
    renderSel(); updateRibbon(); draw();
    exStatus(set.length ? `${l.name} selected — ${set.length} element${set.length === 1 ? '' : 's'}` : `${l.name} has nothing shown to select`);
  });
}
document.getElementById('layerNew').onclick = () => {
  let n = state.layers.length + 1; while (state.layers.some(l => l.name === 'Layer ' + n)) n++;
  const l = makeLayer({name:'Layer ' + n}); state.layers.push(l); state.activeLayer = l.id; renderLayers();
};
/** A run's centreline laid without any avoidance, as a path with its depths:
    its current route when it has one, else a fresh route past nothing. */
function plainPath(cn){
  const A = byUid(cn.a.mh), B = byUid(cn.b.mh);
  if (!A || !B) return null;
  const zPitch = Math.max(1, A.zSpace || 0, B.zSpace || 0), zFlat = chamberZ0(A) - (cn.level|0)*zPitch;
  let rt = cn.route && cn.route.ok ? cn.route : null;
  if (!rt){
    const G = buildBanks().find(g => g.members.includes(cn));
    if (!G) return null;
    const r = solveRoute(G.PS, G.d0, G.PE, G.d2, G.spec, [], {plan:true});
    if (!r.ok) return null;
    rt = r;
  }
  const pf = rt.profile, cum = [0];
  for (let i = 1; i < rt.pts.length; i++) cum.push(cum[i-1] + Math.hypot(rt.pts[i][0]-rt.pts[i-1][0], rt.pts[i][1]-rt.pts[i-1][1]));
  const k = (rt.length || cum[cum.length-1] || 1) / (cum[cum.length-1] || 1);
  return rt.pts.map((p, i) => [p[0], p[1], pf ? profileZ(pf, cum[i]*k) : zFlat]);
}
/** Update routes: every dynamic layer is routed again round everything static
    and encased; every static layer is fixed as it stands — a modelled path
    kept, anything else laid without avoidance and then fixed. */
function updateLayers(){
  let fixed = 0, freed = 0, stuck = 0;
  for (const cn of state.connections){
    if (layerMode(cn) === 'static'){
      if (cn.fixed && Array.isArray(cn.fixedPath) && cn.fixedPath.length >= 2) continue;
      const path = Array.isArray(cn.modelPath) && cn.modelPath.length >= 2 ? cn.modelPath : plainPath(cn);
      if (path){ cn.fixed = true; cn.fixedPath = path; fixed++; } else stuck++;
    } else if (cn.fixed){ delete cn.fixed; delete cn.fixedPath; freed++; }
  }
  bankCache.clear(); renderSel(); renderConnections(); draw();
  exStatus(`routes updated — ${fixed} fixed as static, ${freed} routed again with avoidance${stuck ? `, ${stuck} with no route to fix` : ''}`);
}
document.getElementById('layerUpdate').onclick = updateLayers;

/* ==========================================================================
   ICONS
   Small line icons for the ribbon and the radial menu, drawn once here.
   ========================================================================== */

const ICONS = {
  undo:     '<path d="M9 14L4 9l5-5"/><path d="M4 9h9.5a5.5 5.5 0 0 1 0 11H10"/>',
  lock:     '<rect x="5" y="11" width="14" height="10" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  elevation:'<rect x="3" y="5" width="18" height="14"/><rect x="6" y="8" width="12" height="8" stroke-dasharray="2 2"/><circle cx="9.5" cy="12" r="1.8"/><circle cx="14.5" cy="12" r="1.8"/>',
  redo:     '<path d="M15 14l5-5-5-5"/><path d="M20 9h-9.5a5.5 5.5 0 0 0 0 11H14"/>',
  chamber:  '<rect x="4" y="4" width="16" height="16"/><rect x="8" y="8" width="8" height="8"/>',
  encase:   '<rect x="3" y="6" width="18" height="12" rx="1"/><circle cx="8" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="16" cy="12" r="2"/>',
  layers:   '<path d="M12 4l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/><path d="M3 17l9 5 9-5"/>',
  models:   '<rect x="3" y="4" width="8" height="7"/><rect x="13" y="4" width="8" height="7"/><rect x="3" y="13" width="8" height="7"/><path d="M13 16.5h8M17 13v7"/>',
  obstacle: '<rect x="4" y="5" width="16" height="14"/><path d="M4 12l7-7M4 18l13-13M9 19l11-11M15 19l5-5"/>',
  cube:     '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
  plan:     '<rect x="4" y="4" width="16" height="16"/><path d="M4 12h16M12 4v16"/>',
  fit:      '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><rect x="9" y="9" width="6" height="6"/>',
  chambers: '<rect x="3" y="4" width="7" height="7"/><rect x="3" y="13" width="7" height="7"/><path d="M13 7.5h8M13 16.5h8"/>',
  runs:     '<path d="M3 16h5l4-8h9"/><circle cx="3.5" cy="16" r="1.6"/><circle cx="20.5" cy="8" r="1.6"/>',
  obstacles:'<rect x="3" y="6" width="18" height="12"/><path d="M3 13l7-7M6 18l12-12M13 18l8-8"/>',
  specs:    '<path d="M4 12V4h8l8 8-8 8z"/><circle cx="8" cy="8" r="1.6"/>',
  drawing:  '<rect x="4" y="4" width="16" height="16"/><path d="M4 10h16M4 16h16M10 4v16M16 4v16"/>',
  file:     '<path d="M6 3h8l5 5v13H6z M14 3v5h5"/><path d="M9 13h6M9 17h6"/>',
  edit:     '<path d="M4 20l4-1L19 8l-3-3L5 16z M13 7l3 3"/>',
  duplicate:'<rect x="8" y="8" width="12" height="12"/><path d="M4 16V4h12"/>',
  delete:   '<path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 11v6M14 11v6"/>',
  connect:  '<path d="M9 12h6M6 9a3 3 0 0 0 0 6h3M18 15a3 3 0 0 0 0-6h-3"/>',
  place:    '<path d="M5 13l4 4L19 7"/>',
  disconnect:'<path d="M3 12h5M16 12h5M10 8l4 8M14 8l-4 8"/>',
  around:   '<rect x="8" y="11" width="8" height="8"/><path d="M3 19V9a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v10"/>',
  over:     '<rect x="8" y="12" width="8" height="8"/><path d="M3 14a9 9 0 0 1 18 0"/>',
  under:    '<rect x="8" y="4" width="8" height="8"/><path d="M3 10a9 9 0 0 0 18 0"/>',
  sides:    '<rect x="5" y="5" width="14" height="14"/><path d="M19 5v14" stroke-width="3.2"/>',
  cancel:   '<path d="M6 6l12 12M18 6L6 18"/>',
  add:      '<path d="M12 5v14M5 12h14"/>',
  example:  '<rect x="3" y="14" width="6" height="6"/><rect x="15" y="4" width="6" height="6"/><rect x="15" y="14" width="6" height="6"/><path d="M9 17h6M18 10v4"/>'
};
const icon = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k] || ''}</svg>`;
document.querySelectorAll('[data-icon]').forEach(b => b.insertAdjacentHTML('afterbegin', icon(b.dataset.icon)));
document.getElementById('chamberLock').innerHTML = icon('lock');

/* ==========================================================================
   RADIAL MENU
   Right-click anything on the drawing for a ring of what you can do to it —
   a face offers to connect from it (or to it, once a connection is begun).
   ========================================================================== */

const RADIAL = document.getElementById('radial');
/* A ring opened under a held finger is not armed until a fresh press lands inside it: the finger that opened
   it lifts onto the hub, and the click the browser makes of that lift must not close it. */
let ringArmed = true;
RADIAL.addEventListener('keydown', () => { ringArmed = true; });
RADIAL.addEventListener('pointerdown', () => { ringArmed = true; });   // a fresh press on the ring itself, wherever it is hosted
function openRadial(sp, hub, items, host = STAGE){
  if (RADIAL.parentElement !== host) host.appendChild(RADIAL);      // the ring lives wherever it was asked for
  const r = host.getBoundingClientRect();
  const R = items.length > 6 ? 82 : items.length > 4 ? 70 : 62, pad = R + 32;
  const cx = Math.max(pad, Math.min(r.width - pad, sp[0])), cy = Math.max(pad, Math.min(r.height - pad, sp[1]));
  RADIAL.style.left = cx + 'px'; RADIAL.style.top = cy + 'px';
  RADIAL.innerHTML = `<div class="ring" style="left:${-R}px;top:${-R}px;width:${2*R}px;height:${2*R}px"></div>` +
    items.map((it, i) => {
      const a = -Math.PI/2 + i*2*Math.PI/items.length;
      return `<button class="ritem${it.warn ? ' warn' : ''}" data-ri="${i}" title="${esc(it.label)}"
        style="left:${(R*Math.cos(a)).toFixed(1)}px;top:${(R*Math.sin(a)).toFixed(1)}px">${icon(it.icon)}<span>${esc(it.label)}</span></button>`;
    }).join('') + `<div class="rhub" title="Esc closes">${esc(hub)}</div>`;
  RADIAL.hidden = false; ringArmed = true;
  state.hoverFace = null; showCallout(null);
  RADIAL.querySelectorAll('[data-ri]').forEach(b => b.onclick = ev => { ev.stopPropagation(); if (!ringArmed) return; const it = items[+b.dataset.ri]; closeRadial(); it.run(); });
  RADIAL.querySelector('.rhub').onclick = ev => { ev.stopPropagation(); if (ringArmed) closeRadial(); };
}
function closeRadial(){ if (!RADIAL.hidden){ RADIAL.hidden = true; RADIAL.innerHTML = ''; } }

function faceMenu(f){
  const c = byUid(f.mh), items = [];
  const samePending = state.pending && state.pending.mh === f.mh && state.pending.face === f.face;
  if (state.pending && !samePending)
    items.push({icon:'connect', label:'Connect here', run:() => pickFace(f)},
               {icon:'cancel', label:'Cancel', warn:true, run:() => { state.pending = null; setPendingStatus(); draw(); }});
  else if (samePending)
    items.push({icon:'cancel', label:'Cancel', warn:true, run:() => { state.pending = null; setPendingStatus(); draw(); }});
  else
    items.push({icon:'connect', label:'Connect from', run:() => { state.pending = f; setPendingStatus(); draw(); }});
  items.push({icon:'elevation', label:'Elevation', run:() => openElevation(f.mh, f.face)});
  items.push({icon:'edit', label:'Chamber', run:() => { select('chamber', c.uid); openWin('chambers'); }});
  return [`${c ? c.ref : '?'} · ${f.face}`, items];
}
function chamberMenu(c){
  return [c.ref, [
    {icon:'edit', label:'Edit', run:() => { select('chamber', c.uid); openWin('chambers'); }},
    {icon:'runs', label:'Runs', run:() => openWin('runs')},
    {icon:'duplicate', label:'Duplicate', run:() => {
      const n = makeChamber({...c, uid:uid(), ref:nextRef(), x:c.x + c.intX + 2*c.wall + 1000});
      state.chambers.push(n); select('chamber', n.uid); }},
    {icon:'fit', label:'Fit view', run:() => fitView()},
    deleteItem(() => removeChamber(c.uid))
  ]];
}
/** The ring's delete entry: the whole selection when it holds several things, else just this one. */
function deleteItem(one, icon = 'delete', label = 'Delete'){
  const n = state.selSet.length;
  return n > 1 ? {icon:'delete', label:`Delete ${n}`, warn:true, run:deleteSelection}
               : {icon, label, warn:true, run:one};
}
function obstacleMenu(o){
  const setM = m => () => { o.method = m; select('obstacle', o.uid); };
  return [o.name, [
    {icon:'edit', label:'Edit', run:() => { select('obstacle', o.uid); openWin('obstacles'); }},
    {icon:'around', label:'Around', run:setM('around')},
    {icon:'over', label:'Over', run:setM('over')},
    {icon:'under', label:'Under', run:setM('under')},
    {icon:'duplicate', label:'Duplicate', run:() => {
      const n = makeObstacle({...o, uid:uid(), name:nextName(), x:o.x + o.w + 1000});
      state.obstacles.push(n); select('obstacle', n.uid); }},
    deleteItem(() => {
      state.obstacles = state.obstacles.filter(x => x.uid !== o.uid);
      state.sel = null; renderSel(); renderObstacles(); renderConnections(); draw(); })
  ]];
}
function runMenu(cn){
  const rt = cn.route;
  return [connLabel(cn), [
    {icon:'edit', label:'Edit', run:() => { select('conn', cn.uid); openWin('runs'); }},
    {icon:'place', label: cn.placed ? 'Update line' : 'Place line', run:() => { if (rt && rt.ok){ cn.placed = true; select('conn', cn.uid); } }},
    {icon:'specs', label:'Spec', run:() => { state.editSpec = cn.specId; renderSpecs(); renderSpecEdit(); openWin('specs'); }},
    deleteItem(() => disconnect(cn.uid), 'disconnect', 'Disconnect')
  ]];
}
function spaceMenu(wp){
  return ['drawing', [
    {icon:'chamber', label:'Chamber here', run:() => {
      const base = state.chambers[state.chambers.length-1];
      const c = makeChamber({x:snap(wp[0]), y:snap(wp[1]), intX: base ? base.intX : 1200, intY: base ? base.intY : 1200, wall: base ? base.wall : 150});
      state.chambers.push(c); select('chamber', c.uid); }},
    {icon:'obstacle', label:'Obstacle here', run:() => { const o = makeObstacle({x:snap(wp[0]), y:snap(wp[1])}); state.obstacles.push(o); select('obstacle', o.uid); }},
    {icon:'cube', label:'3D view', run:() => setView3d(true)},
    {icon:'fit', label:'Fit view', run:() => fitView()},
    {icon:'runs', label:'Runs', run:() => openWin('runs')}
  ]];
}

/* ==========================================================================
   RIBBON WINDOWS
   Every panel is a window opened from its ribbon button — all of them
   always available, several open at once, dragged by their title bar. The
   ribbon lights the buttons that concern whatever is selected.
   ========================================================================== */

const WINS = ['chambers', 'runs', 'obstacles', 'layers', 'models', 'specs', 'examples', 'drawing', 'file', 'elevation', 'view3d'];
let winZ = 30;
const winEl = k => document.getElementById('win-' + k);
/** A window opens in the first free slot from the right edge, so several
    open side by side; once the row is full they cascade. */
function placeWin(el){
  const r = STAGE.getBoundingClientRect();
  const taken = [...document.querySelectorAll('.win')].filter(w => w !== el && !w.hidden).map(w => w.offsetLeft);
  const w = (el.offsetWidth || 316) + 12;
  for (let i = 0; ; i++){
    const x = r.width - w - i*324;
    if (x < 8){ const n = WINS.indexOf(el.id.slice(4)); el.style.left = Math.max(8, r.width - w - n*36) + 'px'; el.style.top = (12 + n*36) + 'px'; return; }
    if (!taken.some(t => Math.abs(t - x) < 40)){ el.style.left = x + 'px'; el.style.top = '12px'; return; }
  }
}
function openWin(k){
  const el = winEl(k);
  if (!el) return;
  const was = el.hidden;
  if (el.hidden){ el.hidden = false; if (!el.dataset.moved) placeWin(el); }     // a dragged window keeps its place
  el.style.zIndex = ++winZ;
  if (k === 'view3d' && was){ state.view3d = true; state.pending = null; setPendingStatus(); fit3d(); }
  if (k === 'elevation' && was) renderElevation();
  if (k === 'layers') renderLayers();
  if (k === 'models') renderModels();
  updateRibbon();
}
function closeWin(k){
  const el = winEl(k); if (el) el.hidden = true;
  if (k === 'view3d'){ state.view3d = false; if (RADIAL.parentElement === V3BODY) closeRadial(); }
  if (k === 'elevation') state.elev = null;
  updateRibbon();
}
function toggleWin(k){ const el = winEl(k); if (el){ if (el.hidden) openWin(k); else closeWin(k); } }
function updateRibbon(){
  const rel = ({chamber:['chambers'], obstacle:['obstacles'], conn:['runs', 'specs']})[state.sel ? state.sel.kind : ''] || [];
  document.querySelectorAll('[data-win]').forEach(b => {
    const el = winEl(b.dataset.win);
    b.classList.toggle('on', !!el && !el.hidden);
    b.classList.toggle('rel', rel.includes(b.dataset.win));
  });
  document.getElementById('chamberLock').hidden = !state.lockChambers;
}
document.querySelectorAll('[data-win]').forEach(b => b.onclick = () => toggleWin(b.dataset.win));
document.querySelectorAll('.win').forEach(el => {
  el.querySelector('[data-close]').onclick = () => closeWin(el.id.slice(4));
  el.addEventListener('pointerdown', () => { el.style.zIndex = ++winZ; });
  const head = el.querySelector('.winhead');
  head.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const sx = e.clientX, sy = e.clientY, ox = el.offsetLeft, oy = el.offsetTop;
    const move = ev => { el.dataset.moved = '1'; el.style.left = Math.max(0, ox + ev.clientX - sx) + 'px'; el.style.top = Math.max(0, oy + ev.clientY - sy) + 'px'; };
    const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); };
    head.setPointerCapture(e.pointerId);
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
  });
  if (el.classList.contains('resizable')){                 // a grip in the corner stretches the window
    el.insertAdjacentHTML('beforeend', '<div class="wingrip" title="Drag to resize"></div>');
    const grip = el.querySelector('.wingrip');
    grip.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      const sx = e.clientX, sy = e.clientY, w0 = el.offsetWidth, h0 = el.offsetHeight;
      const move = ev => { el.dataset.moved = '1'; el.style.width = Math.max(320, w0 + ev.clientX - sx) + 'px'; el.style.height = Math.max(220, h0 + ev.clientY - sy) + 'px'; };
      const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); };
      grip.setPointerCapture(e.pointerId);
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    });
  }
});
document.getElementById('v3hint').textContent = TOUCH_UI
  ? 'one finger orbits · two fingers pan and zoom · tap to select · hold for the menu'
  : 'drag or shift+middle drag to orbit · middle or right drag to pan · scroll to zoom · click to select';
document.getElementById('snap').oninput = e => { state.snap = Math.max(0, Number(e.target.value)||0); };
document.getElementById('grid').onchange = e => { state.showGrid = e.target.checked; draw(); };
document.getElementById('dims').onchange = e => { state.showDims = e.target.checked; draw(); };
document.getElementById('avoidMH').onchange = e => {
  state.avoidChambers = e.target.checked; renderSel(); renderConnections(); draw();
};
document.getElementById('avoidPipe').onchange = e => {
  state.avoidPipes = e.target.checked; renderSel(); renderConnections(); draw();
};
document.getElementById('lockMH').onchange = e => {
  state.lockChambers = e.target.checked; renderSel(); updateRibbon(); draw();
};
for (const [id, key] of [['ground','ground'], ['cover','cover']])
  document.getElementById(id).oninput = e => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v) || (key === 'cover' && v < 0)) return;
    state[key] = v; renderSel(); renderConnections(); draw();
  };
function syncDrawingInputs(){
  document.getElementById('ground').value = state.ground;
  document.getElementById('cover').value = state.cover;
  document.getElementById('lockMH').checked = !!state.lockChambers;
}

document.getElementById('btnExport').onclick = () => {
  recomputeRoutes();
  const revitDocs = [...new Set([...state.chambers, ...state.obstacles].map(e => e.revitDoc).filter(Boolean))];
  const data = {
    units:'mm', axes:'+X east, +Y north',
    ground: state.ground, cover: state.cover, lockChambers: state.lockChambers,
    revit: revitDocs.length ? {documents: revitDocs} : undefined,
    specs: state.specs.map(({id, ...rest}) => rest),
    layers: state.layers, activeLayer: activeLayerId(),
    chambers: state.chambers.map(({uid, ...rest}) => rest),
    obstacles: state.obstacles.map(({uid, ...rest}) => rest),
    runs: state.connections.map(cn => {
      const rt = cn.route, sp = specOf(cn);
      const A = byUid(cn.a.mh), B = byUid(cn.b.mh);
      const ea = entryFor(cn,'a'), eb = entryFor(cn,'b');
      return {
        from:{ref: A?.ref, face: cn.a.face, lateralOffset: ea ? Math.round(ea.offset) : 0,
              zOffset: A ? -(cn.level|0)*A.zSpace : 0, z: A ? chamberZ0(A) - (cn.level|0)*A.zSpace : null,
              revitId: A?.revitId ?? undefined, revitUid: A?.revitUid ?? undefined},
        to:  {ref: B?.ref, face: cn.b.face, lateralOffset: eb ? Math.round(eb.offset) : 0,
              zOffset: B ? -(cn.level|0)*B.zSpace : 0, z: B ? chamberZ0(B) - (cn.level|0)*B.zSpace : null,
              revitId: B?.revitId ?? undefined, revitUid: B?.revitUid ?? undefined},
        spec: sp ? sp.name : null,
        level: cn.level|0,
        obstacleRules: (() => { const e = {}; for (const o of state.obstacles) if (cn.cross && METHODS.includes(cn.cross[o.uid])) e[o.name] = cn.cross[o.uid];
                                return Object.keys(e).length ? e : undefined; })(),
        rows: runRows(cn), cols: runCols(cn), perRow: runRowsOf(cn), align: runAlignPref(cn), packedTo: runAlign(cn),
        static: cn.fixed ? true : undefined, path: cn.fixed && Array.isArray(cn.fixedPath) ? cn.fixedPath.map(q => q.map(v => Math.round(v*10)/10)) : undefined,
        modelPath: Array.isArray(cn.modelPath) ? cn.modelPath.map(q => q.map(v => Math.round(v*10)/10)) : undefined,
        layer: cn.layer || DEFAULT_LAYER, encased: cn.encased ? true : undefined,
        spacing: {across: Math.round(runSpace(cn)), down: Math.round(runZSpace(cn))},
        encasement: (() => { const E = runEncasement(cn); return E ? {offset: E.off, width: Math.round(E.W), height: Math.round(E.H)} : undefined; })(),
        placed: cn.placed,
        route: rt && rt.ok ? {
          vertices: rt.pts.map(p => [Math.round(p[0]), Math.round(p[1])]),
          bends: rt.turns.map((t,i) => ({deflection:t, radius: Math.round(rt.fillets[i].R)})),
          straights: rt.segs.map(v => Math.round(v)),
          straightDuct: rt.clear.map(v => Math.round(Math.max(0,v))),
          centrelineLength: Math.round(rt.length),
          laidLength: Math.round(rt.length3d || rt.length),
          crossings: (rt.crossings || []).map(x => ({obstacle:x.name, mode:x.mode, from:Math.round(x.s0), to:Math.round(x.s1), z:Math.round(x.z)})),
          section: rt.profile ? {
            vertices: rt.profile.pts.map(p => [Math.round(p[0]), Math.round(p[1])]),
            bends: rt.profile.turns.map((t,i) => ({deflection:t, radius: Math.round(rt.profile.fillets[i].R)})),
            straights: rt.profile.segs.map(v => Math.round(v))
          } : null,
          warnings: rt.warnings.map(w => w.text)
        } : null,
        error: rt && !rt.ok ? rt.msg : undefined
      };
    })
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'manhole-plan.json'; a.click();
  URL.revokeObjectURL(a.href);
};

document.getElementById('fileIn').onchange = e => {
  const f = e.target.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const d = JSON.parse(rd.result);
      if (Array.isArray(d.specs) && d.specs.length)
        state.specs = d.specs.map(s => makeSpec({...s, id:uid(),
          minLeg: s.minLeg != null ? s.minLeg : (s.stub != null ? s.stub : 500),
          angles:[...(s.angles||[])]}));
      if (Number.isFinite(d.ground)) state.ground = d.ground;
      if (Number.isFinite(d.cover) && d.cover >= 0) state.cover = d.cover;
      if (typeof d.lockChambers === 'boolean') state.lockChambers = d.lockChambers;
      syncDrawingInputs();
      const hadLayers = Array.isArray(d.layers) && d.layers.length > 0;
      state.layers = hadLayers ? d.layers.map(l => makeLayer({...l})) : [makeLayer({id:DEFAULT_LAYER, name:'Drawing'})];
      if (!layerById(DEFAULT_LAYER)) state.layers.unshift(makeLayer({id:DEFAULT_LAYER, name:'Drawing'}));
      state.activeLayer = layerById(d.activeLayer) ? d.activeLayer : DEFAULT_LAYER;
      state.chambers  = (d.chambers ||[]).map(c => makeChamber({buffer:0, ...c, uid:uid()}));
      state.obstacles = (d.obstacles||[]).map(o => {
        const m = makeObstacle({...o, method: obsMethod(o), buffer: o.buffer != null ? o.buffer : (o.clearance != null ? o.clearance : 250), uid:uid()});
        delete m.clearance; delete m.around; delete m.over; delete m.under; return m;
      });
      const byRef  = r => state.chambers.find(c => c.ref === r);
      const byName = n => state.specs.find(s => s.name === n) || state.specs[0];
      state.connections = (d.runs || d.connections || []).map(cn => {
        const A = byRef(cn.from?.ref), B = byRef(cn.to?.ref);
        if (!A || !B) return null;
        return {uid:uid(), a:{mh:A.uid, face:legacyFace(cn.from.face)}, b:{mh:B.uid, face:legacyFace(cn.to.face)},
                placed: !!cn.placed, level: Math.max(0, cn.level|0),
                perRow: runRowsOf(cn), align: ALIGNS.includes(cn.align) ? cn.align : 'auto',
                fixed: !!cn.static && Array.isArray(cn.path) && cn.path.length >= 2, fixedPath: cn.static && Array.isArray(cn.path) && cn.path.length >= 2 ? cn.path.map(q => [Number(q[0]), Number(q[1]), Number(q[2]) || 0]) : undefined,
                modelPath: Array.isArray(cn.modelPath) && cn.modelPath.length >= 2 ? cn.modelPath.map(q => [Number(q[0]), Number(q[1]), Number(q[2]) || 0]) : undefined,
                layer: layerById(cn.layer) ? cn.layer : undefined, encased: cn.encased === true ? true : undefined,
                cross: Object.fromEntries(Object.entries(cn.obstacleRules || {}).map(([nm, m]) => {
                  const ob = state.obstacles.find(x => x.name === nm); return ob && METHODS.includes(m) ? [ob.uid, m] : null; }).filter(Boolean)),
                specId: byName(cn.spec).id, route:null};
      }).filter(Boolean);
      if (!hadLayers){                                                  // an older file: its static models become static layers, the rest is the Drawing layer
        const docs = new Map();
        for (const c of state.chambers){
          if (c.revitDoc && !layerById(c.layer)){
            if (!docs.has(c.revitDoc)) docs.set(c.revitDoc, ensureLayer(docLayerName({document:c.revitDoc})));
            c.layer = docs.get(c.revitDoc).id;
            if (c.fixed) docs.get(c.revitDoc).mode = 'static';
          }
          delete c.fixed;
        }
        for (const o of state.obstacles) if (o.revitDoc && docs.has(o.revitDoc) && !layerById(o.layer)) o.layer = docs.get(o.revitDoc).id;
      }
      for (const cn of state.connections) if (!layerById(cn.layer)){ const A = byUid(cn.a.mh); cn.layer = A && layerById(A.layer) ? A.layer : DEFAULT_LAYER; }
      state.sel = null; state.editSpec = state.specs[0].id;
      renderSpecs(); renderSpecEdit(); renderSel(); renderConnections(); renderObstacles(); fitView();
    } catch(err){ alert('That file is not a plan export. Expected JSON with a chambers array.'); }
    e.target.value = '';
  };
  rd.readAsText(f);
};

/* ==========================================================================
   REVIT IMPORT
   Reads the JSON written by export_manholes.py: per family, the named
   reference planes (a1..a7, b1..b7, z1..z6 and the six conduit-boundary
   planes) in family coordinates, plus each placed instance's origin and
   axes. a1/a7 and b1/b7 are the chamber's external faces, a2/a6 and b2/b6
   the inside faces of the walls, a3/a5 and b3/b5 the lid outline. The
   conduit-boundary planes bound the insertion window on the sides
   perpendicular to their letter; the z pair gives the window height.
   ========================================================================== */

function importRevit(d){
  const made = [];
  for (const F of (Array.isArray(d.families) ? d.families : [])){
    const P = {};
    for (const p of (F.planes || [])) if (p && p.name && p.normal) P[String(p.name).toLowerCase()] = p;
    if (!(P.a1 && P.a7 && P.b1 && P.b7)) continue;
    const axisIdx = p => Math.abs(p.normal[0]) >= Math.abs(p.normal[1]) ? 0 : 1;
    const pos  = p => p ? p.offset_mm * (Math.sign(p.normal[axisIdx(p)]) || 1) : null;
    const zpos = p => p ? p.offset_mm * (Math.sign(p.normal[2]) || 1) : null;
    const aIdx = axisIdx(P.a1), bIdx = axisIdx(P.b1);
    if (aIdx === bIdx) continue;
    const seq = L => Array.from({length:7}, (_, i) => pos(P[L + (i+1)]));
    const a = seq('a'), b = seq('b');
    const z = Array.from({length:6}, (_, i) => zpos(P['z' + (i+1)]));
    const zs = z.filter(v => v != null);
    const pick = (arr, i, fb) => arr[i] != null ? arr[i] : fb;
    const ext = {a:[a[0], a[6]], b:[b[0], b[6]]};
    const inn = {a:[pick(a,1,a[0]), pick(a,5,a[6])], b:[pick(b,1,b[0]), pick(b,5,b[6])]};
    const ctr = {a:(ext.a[0]+ext.a[1])/2, b:(ext.b[0]+ext.b[1])/2};
    const walls = [inn.a[0]-ext.a[0], ext.a[1]-inn.a[1], inn.b[0]-ext.b[0], ext.b[1]-inn.b[1]].filter(v => v > 0);
    const wall = walls.length ? Math.round(walls.reduce((x,y) => x+y, 0)/walls.length) : 150;
    const cb = L => {
      const p1 = P[L + '_conduit_boundary_1'], p2 = P[L + '_conduit_boundary_2'];
      if (!p1 || !p2) return null;
      const v = L === 'z' ? [zpos(p1), zpos(p2)] : [pos(p1), pos(p2)];
      return {lo:Math.min(v[0], v[1]), hi:Math.max(v[0], v[1])};
    };
    const wA = cb('a'), wB = cb('b'), wZ = cb('z');
    const winH = wZ ? Math.round(wZ.hi - wZ.lo) : null;
    const winPerpA = wA ? {w:Math.round(wA.hi - wA.lo), off:Math.round((wA.lo + wA.hi)/2 - ctr.b), h:winH} : null;
    const winPerpB = wB ? {w:Math.round(wB.hi - wB.lo), off:Math.round((wB.lo + wB.hi)/2 - ctr.a), h:winH} : null;
    /* the tool's local X is the family X: sides B = +X, D = -X, A = +Y, C = -Y */
    const aIsX = aIdx === 0;
    const intX = aIsX ? inn.a[1]-inn.a[0] : inn.b[1]-inn.b[0];
    const intY = aIsX ? inn.b[1]-inn.b[0] : inn.a[1]-inn.a[0];
    const sidesBase = aIsX ? {B:'a7', D:'a1', A:'b7', C:'b1'} : {B:'b7', D:'b1', A:'a7', C:'a1'};
    const winBase = aIsX ? {B:winPerpA, D:winPerpA, A:winPerpB, C:winPerpB}
                         : {B:winPerpB, D:winPerpB, A:winPerpA, C:winPerpA};
    const lidX = aIsX ? (a[2] != null && a[4] != null ? [a[2]-ctr.a, a[4]-ctr.a] : null)
                      : (b[2] != null && b[4] != null ? [b[2]-ctr.b, b[4]-ctr.b] : null);
    const lidY = aIsX ? (b[2] != null && b[4] != null ? [b[2]-ctr.b, b[4]-ctr.b] : null)
                      : (a[2] != null && a[4] != null ? [a[2]-ctr.a, a[4]-ctr.a] : null);
    const fx = aIsX ? ctr.a : ctr.b, fy = aIsX ? ctr.b : ctr.a;
    const insts = (F.instances && F.instances.length) ? F.instances
      : [{origin_mm:[0,0,0], family_x_axis:[1,0,0], family_y_axis:[0,1,0], rotation_deg:0}];
    for (const inst of insts){
      const bx = inst.family_x_axis || [1,0,0], by = inst.family_y_axis || [0,1,0], o = inst.origin_mm || [0,0,0];
      const wx = o[0] + bx[0]*fx + by[0]*fy, wy = o[1] + bx[1]*fx + by[1]*fy;
      const rot = inst.rotation_deg != null ? inst.rotation_deg : Math.atan2(bx[1], bx[0])*R2D;
      const mirrored = inst.mirrored === true || (bx[0]*by[1] - bx[1]*by[0]) < 0;   // Revit's flag, or a left-handed basis: family +Y is local -Y
      const flipW = w => w ? {...w, off:-w.off} : w;
      const sides = mirrored ? {A:sidesBase.C, C:sidesBase.A, B:sidesBase.B, D:sidesBase.D} : {...sidesBase};
      const win = mirrored ? {A:winBase.C, C:winBase.A, B:flipW(winBase.B), D:flipW(winBase.D)} : {...winBase};
      const lid = lidX && lidY ? {x:lidX, y: mirrored ? [-lidY[1], -lidY[0]] : lidY} : null;
      made.push(makeChamber({
        ref: inst.mark || null,
        revitId: inst.id != null ? inst.id : null, revitUid: inst.unique_id || null, revitDoc: d.document || d.source || null,
        x: Math.round(wx), y: Math.round(wy), rot: Math.round(rot*100)/100,
        intX: Math.round(intX), intY: Math.round(intY), wall,
        z0: inst.z0_mm != null ? Math.round(inst.z0_mm) : Math.round(o[2] + (wZ ? wZ.hi - 150 : -600)),       // top row a half pitch below the window top, unless the export says where its rows are
        zLid: inst.lid_mm != null ? Math.round(inst.lid_mm) : Math.round(o[2] + (zs.length ? Math.max(...zs) : 0)),
        zBase: inst.base_mm != null ? Math.round(inst.base_mm) : Math.round(o[2] + (zs.length ? Math.min(...zs) : -1800)),
        ...(F.spacing_mm ? {latSpace: Math.max(1, Math.round(F.spacing_mm.lateral || 450)), zSpace: Math.max(1, Math.round(F.spacing_mm.vertical || 300))} : {}),
        sides, win, lid, zd: z, src: 'revit', family: F.family || null, type: inst.type || null
      }));
    }
  }
  /* obstacles: any instance flagged with the obstacle_around / _over / _under
     parameters, as its own bounding box in family coordinates plus placement */
  const obstacles = [];
  for (const ob of (Array.isArray(d.obstacles) ? d.obstacles : [])){
    const mn = ob.local_min_mm, mx = ob.local_max_mm;
    if (!mn || !mx) continue;
    const bx = ob.family_x_axis || [1,0,0], by = ob.family_y_axis || [0,1,0], o = ob.origin_mm || [0,0,0];
    const cx = (mn[0]+mx[0])/2, cy = (mn[1]+mx[1])/2;
    obstacles.push(makeObstacle({
      name: ob.mark || ob.name || null,
      revitId: ob.id != null ? ob.id : null, revitUid: ob.unique_id || null, revitDoc: d.document || d.source || null,
      x: Math.round(o[0] + bx[0]*cx + by[0]*cy), y: Math.round(o[1] + bx[1]*cx + by[1]*cy),
      rot: Math.round((ob.rotation_deg != null ? ob.rotation_deg : Math.atan2(bx[1], bx[0])*R2D)*100)/100,
      w: Math.round(mx[0]-mn[0]), d: Math.round(mx[1]-mn[1]),
      zTop: Math.round(o[2] + mx[2]), zBot: Math.round(o[2] + mn[2]),
      method: obsMethod(ob),
      src: 'revit', family: ob.family || null, type: ob.type || null
    }));
  }
  return {chambers: made, obstacles};
}

/** What identifies an element across exports of the same model: its Revit
    unique id, or its element id within its document. */
const revitKey = e => e.revitUid ? 'u:' + e.revitUid
                    : (e.revitId != null ? 'i:' + e.revitId + '@' + (e.revitDoc || '') : null);

document.getElementById('revitIn').onchange = e => {
  const f = e.target.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try {
      applyRevitImport(JSON.parse(rd.result));
    } catch(err){ alert('That file is not a Revit manhole export: ' + err.message); }
    e.target.value = '';
  };
  rd.readAsText(f);
};

/** Bring a Revit export onto the drawing: refresh what is already here from
    the same model, else ask whether to replace or add. */
/** A reference not yet on the drawing: the mark as it came, a numbered copy when the mark is taken, a fresh one when there is none. */
function uniqueRef(ref){
  if (!ref) return nextRef();
  const taken = r => state.chambers.some(x => x.ref === r);
  if (!taken(ref)) return ref;
  for (let i = 2; ; i++) if (!taken(`${ref} (${i})`)) return `${ref} (${i})`;
}
function applyRevitImport(src, opt = {}){
      const {chambers: made, obstacles: obs} = importRevit(src);
      if (!made.length && !obs.length) throw new Error('no manhole family (a1/a7 and b1/b7 planes) found');
      const lay = ensureLayer(opt.layer || docLayerName(src), opt.fixed ? 'static' : 'dynamic');   // one layer per model, static or dynamic
      for (const c of made) c.layer = lay.id;
      for (const o of obs) o.layer = lay.id;
      const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
      const oldC = new Map(state.chambers.filter(revitKey).map(c => [revitKey(c), c]));
      const oldO = new Map(state.obstacles.filter(revitKey).map(o => [revitKey(o), o]));
      const hits = made.filter(c => oldC.has(revitKey(c))).length + obs.filter(o => oldO.has(revitKey(o))).length;
      if (hits){
        /* a later export of a model already on the drawing: refresh what matches
           in place — every run stays attached — add what is new, keep the rest */
        const CH = ['x','y','rot','intX','intY','wall','sides','win','lid','zd','z0','zLid','zBase','family','type','revitId','revitUid','revitDoc','layer'];
        const OB = ['x','y','rot','w','d','zTop','zBot','family','type','revitId','revitUid','revitDoc','layer'];
        let added = 0;
        for (const c of made){
          const old = oldC.get(revitKey(c));
          if (!old){ c.ref = uniqueRef(c.ref); state.chambers.push(c); added++; continue; }
          for (const k of CH) old[k] = c[k];
          if (c.ref && c.ref !== old.ref && !state.chambers.some(x => x !== old && x.ref === c.ref)) old.ref = c.ref;
        }
        for (const o of obs){
          const old = oldO.get(revitKey(o));
          if (!old){ if (!o.name || state.obstacles.some(x => x.name === o.name)) o.name = nextName(); state.obstacles.push(o); added++; continue; }
          for (const k of OB) old[k] = o[k];
          if (o.name && o.name !== old.name && !state.obstacles.some(x => x !== old && x.name === o.name)) old.name = o.name;
        }
        const seen = new Set([...made, ...obs].map(revitKey)), docNow = src.document || src.source || null;
        const kept = [...state.chambers, ...state.obstacles]
          .filter(e => e.src === 'revit' && revitKey(e) && !seen.has(revitKey(e)) && e.revitDoc === docNow).length;
        document.getElementById('rmode').textContent =
          `Revit update — ${hits} refreshed · ${added} added · ${kept} not in this export, kept`;
      } else {
        const replace = opt.add ? false : (!state.chambers.length && !state.obstacles.length) ||
          confirm(`Import ${n(made.length, 'manhole')} and ${n(obs.length, 'obstacle')} from Revit — replace the current drawing? (Cancel adds them alongside.)`);
        if (replace){ state.chambers = []; state.obstacles = []; state.connections = []; }
        for (const c of made){
          c.ref = uniqueRef(c.ref);
          state.chambers.push(c);
        }
        for (const o of obs){
          if (!o.name || state.obstacles.some(x => x.name === o.name)) o.name = nextName();
          state.obstacles.push(o);
        }
      }
      bankCache.clear();
      state.sel = null; state.selSet = []; state.pending = null;
      renderSel(); renderConnections(); renderObstacles(); fitView();
}

/** Recreate the conduit banks an export lists — each one run between two faces
    with its rows — on that export's chambers already on the drawing. A bank
    already there between the same faces is refreshed, never doubled. */
function recreateRuns(src, opt = {}){
  const runs = Array.isArray(src.runs) ? src.runs : [];
  const doc = src.document || src.source || null;
  const byU = new Map(state.chambers.filter(c => c.revitUid).map(c => ['u:' + c.revitUid, c]));
  const byI = new Map(state.chambers.filter(c => c.revitId != null).map(c => [c.revitId + '@' + (c.revitDoc || ''), c]));
  const find = end => end && ((end.unique_id && byU.get('u:' + end.unique_id)) || (end.id != null && byI.get(end.id + '@' + (doc || ''))) || null);
  let made = 0, kept = 0, missing = 0;
  for (const r of runs){
    const A = find(r.from), B = find(r.to);
    if (!A || !B || !FACES.includes(r.from.face) || !FACES.includes(r.to.face)){ missing++; continue; }
    const sp = specForOD(r.od_mm, r.pitch_mm, r.enc_mm);
    const same = (x, mh, face) => x.mh === mh.uid && x.face === face;
    let cn = state.connections.find(c => (same(c.a, A, r.from.face) && same(c.b, B, r.to.face)) || (same(c.a, B, r.to.face) && same(c.b, A, r.from.face)));
    if (cn) kept++;
    else { cn = {uid:uid(), a:{mh:A.uid, face:r.from.face}, b:{mh:B.uid, face:r.to.face}, placed:true, route:null}; state.connections.push(cn); made++; }
    cn.perRow = runRowsOf(r); cn.align = ALIGNS.includes(r.align) ? r.align : 'auto';
    cn.level = Math.max(0, r.level|0); cn.specId = sp.id; cn.placed = true;
    if (r.encased) cn.encased = true; else delete cn.encased;           // the encasement is modelled in with the run
    delete cn.rows; delete cn.cols;
    const path = Array.isArray(r.path_mm) && r.path_mm.length >= 2 ? r.path_mm.map(q => [Number(q[0]), Number(q[1]), Number(q[2]) || 0]) : null;
    const lay = layerOf(A); cn.layer = lay.id;
    if (path) cn.modelPath = path;                                   // the modelled centreline, kept so the run can go static again
    if (lay.mode === 'static' && path){ cn.fixed = true; cn.fixedPath = path; } else { delete cn.fixed; delete cn.fixedPath; }
  }
  if (made || kept){ bankCache.clear(); state.sel = null; state.selSet = []; renderSel(); renderConnections(); fitView(); }
  return {made, kept, missing, listed: runs.length};
}
/** The spec for a conduit of this outside diameter: the drawing's own when one
    matches, else a new one named for it, at the pitch the export laid it. */
function specForOD(od, pitch, enc){
  const r = (Number(od) || 100)/2;
  let sp = state.specs.find(s => Math.abs(s.radius - r) <= 1);
  if (sp){ if (enc && !encOf(sp)) sp.enc = Math.max(0, Number(enc) || 0); return sp; }
  sp = makeSpec({name:`FIBRE Ø${Math.round(r*2)}`, radius:r, bendR: r >= 50 ? 1200 : 900, stub:500, minLeg:500, buffer:250, enc: Math.max(0, Number(enc) || 0),
                 spacing: Math.max(Math.round(2*r + 50), Math.round(Number(pitch) || 0)), warnAngle:45, angles:[11.25,22.5,45,90]});
  state.specs.push(sp); renderSpecs(); renderSpecEdit();
  return sp;
}
const runsNote = rs => {
  if (!rs.length) return '';
  const made = rs.reduce((a, r) => a + r.made, 0), kept = rs.reduce((a, r) => a + r.kept, 0), miss = rs.reduce((a, r) => a + r.missing, 0);
  const banks = n => `${n} conduit bank${n === 1 ? '' : 's'}`;
  return ' · ' + (made ? `${banks(made)} recreated${kept ? `, ${kept} refreshed` : ''}` : `${banks(kept)} refreshed`) + (miss ? `, ${miss} without both chambers` : '');
};

/* ==========================================================================
   EXAMPLES
   Drawings to place from the Examples window: two Revit exports kept with the
   site, and the demo drawing the tool opens with.
   ========================================================================== */
/* A site is a list of sub-models, one export per service, sharing one set of
   project coordinates. The whole site can be placed at once, or a sub-model
   added to whatever is on the drawing; a sub-model already placed is refreshed
   in place. The MV model came as an IFC rather than a Revit export, and brings
   its conduit banks as runs when its checkbox is ticked. */
const EXAMPLES = [
  {id:'site', name:'LV site',
   blurb:'A live data-centre site, one sub-model per service. Place the whole site, or add a sub-model to the drawing as it stands. Each sub-model is dynamic — the tool routes its runs and its manholes can move — or static: placed as modelled, its manholes stay put, its conduits keep their modelled routes, and dynamic runs keep clear of them.',
   models:[
     {id:'lv', name:'LV', count:'105 manholes', file:'/examples/lv-manholes.json',
      blurb:'The LV model: every manhole of its chamber family at its true position and rotation, with marks, types and Revit ids. The family carries only depth planes, so wall and size are borrowed from the DCBuild family.'},
     {id:'mv', name:'MV', count:'23 manholes · 44 vaults · 8 pull boxes · 77 conduit banks', file:'/examples/mv-manholes.json', runs:true,
      blurb:'The MV model, read from its IFC: the fibre manholes, vaults and pull boxes at their true positions, sizes and depths, and the conduit banks that join two of them — each with the number of conduits in every row, on the Ø128, Ø114 and Ø51 ducts the model uses. Banks that leave the model with an open end are not recreated.'}
   ]},
  {id:'dcbuild', name:'DCBuild test model', count:'3 manholes', file:'/examples/dcbuild-manholes.json',
   blurb:'The three manholes of the DCBuild test project, read from a family that names the full set of side and depth planes.'},
  {id:'demo', name:'Demo drawing', count:'3 chambers · 1 obstacle · 3 runs', file:null,
   blurb:'The drawing the tool opens with: two chambers joined by a pair of placed runs skirting an obstacle, and a third chamber turned 45°.'}
];
let DEMO_DOC = null;
const exRuns = {};                                                  // the conduit checkboxes, by site:model — on unless unticked
const wantRuns = (x, m) => exRuns[x + ':' + m] !== false;
const exMode = {};                                                  // static or dynamic, by site:model — dynamic unless chosen
const modeOf = (x, m) => exMode[x + ':' + m] === 'static' ? 'static' : 'dynamic';
const MODE_NOTE = {dynamic: 'dynamic — the tool routes its runs and its manholes can be moved', static: 'static — placed as modelled: its manholes stay put, its conduits keep their modelled routes, and dynamic runs keep clear of them'};
const exStatus = t => { document.getElementById('rmode').textContent = t; };
const fetchJSON = url => fetch(url, {cache:'no-cache'}).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
function renderExamples(){
  document.getElementById('exampleList').innerHTML = EXAMPLES.map(x => x.models
    ? `<div class="ex"><b>${esc(x.name)}<em>${x.models.length} sub-model${x.models.length === 1 ? '' : 's'}</em></b><p>${esc(x.blurb)}</p>
         ${x.models.map(m => `<div class="sub"><div class="subrow"><span class="nm">${esc(m.name)}<em>${esc(m.count)}</em></span>
           <select class="mini exmode" data-mode="${x.id}:${m.id}" title="${esc(MODE_NOTE[modeOf(x.id, m.id)])}">${['dynamic','static'].map(k => `<option value="${k}"${modeOf(x.id, m.id) === k ? ' selected' : ''}>${k}</option>`).join('')}</select>
           <button class="mini" data-model="${x.id}:${m.id}" title="Add ${esc(m.name)} to the drawing, or refresh it if it is already there">Add</button></div>
           <p>${esc(m.blurb)}</p>${m.runs ? `<label class="chk exopt"><input type="checkbox" data-runsopt="${x.id}:${m.id}"${wantRuns(x.id, m.id) ? ' checked' : ''}> Recreate the conduits from the IFC as runs</label>` : ''}</div>`).join('')}
         <button class="mini" data-example="${x.id}">Place site</button></div>`
    : `<div class="ex"><b>${esc(x.name)}<em>${esc(x.count)}</em></b><p>${esc(x.blurb)}</p><button class="mini" data-example="${x.id}">Place</button></div>`).join('');
  document.querySelectorAll('[data-example]').forEach(b => b.onclick = () => placeExample(b.dataset.example));
  document.querySelectorAll('[data-model]').forEach(b => b.onclick = () => { const [x, m] = b.dataset.model.split(':'); addModel(x, m); });
  document.querySelectorAll('[data-runsopt]').forEach(el => el.onchange = () => { exRuns[el.dataset.runsopt] = el.checked; });
  document.querySelectorAll('[data-mode]').forEach(el => el.onchange = () => { exMode[el.dataset.mode] = el.value; el.title = MODE_NOTE[el.value]; });
}
/** Place an example: the demo from its snapshot, a single export as an import, a site as every sub-model in turn. */
function placeExample(id){
  const x = EXAMPLES.find(e => e.id === id);
  if (!x) return;
  if (x.models){
    Promise.all(x.models.map(m => fetchJSON(m.file)))            // everything fetched first, so a failure places nothing
      .then(srcs => { srcs.forEach((src, i) => applyRevitImport(src, {...(i ? {add:true} : {}), fixed: modeOf(x.id, x.models[i].id) === 'static', layer: x.models[i].name}));
                      const rs = x.models.map((m, i) => m.runs && wantRuns(x.id, m.id) ? recreateRuns(srcs[i], {fixed: modeOf(x.id, m.id) === 'static'}) : null).filter(Boolean);
                      exStatus(`example placed — ${x.name} · ${state.chambers.length} manholes` + runsNote(rs)); })
      .catch(err => alert('The example could not be loaded: ' + err.message));
    return;
  }
  if (!x.file){
    if (state.chambers.length || state.obstacles.length){ if (!confirm('Replace the current drawing with the demo drawing?')) return; }
    applySnapshot(DEMO_DOC); fitView(); exStatus('example placed — the demo drawing'); return;
  }
  fetchJSON(x.file)
    .then(src => { applyRevitImport(src); const from = String(src.source || x.name).split(/[\\/]/).pop();
                   exStatus(`example placed — ${state.chambers.length} manholes from ${from}`); })
    .catch(err => alert('The example could not be loaded: ' + err.message));
}
/** Add one sub-model to the drawing as it stands; if it is already there, it is refreshed in place. */
function addModel(exId, mId){
  const x = EXAMPLES.find(e => e.id === exId), m = x && x.models && x.models.find(k => k.id === mId);
  if (!m) return;
  fetchJSON(m.file)
    .then(src => { const before = state.chambers.length; const fixed = modeOf(exId, mId) === 'static';
                   applyRevitImport(src, {add:true, fixed, layer: m.name}); const n = state.chambers.length - before;
                   const rs = m.runs && wantRuns(exId, mId) ? [recreateRuns(src, {fixed})] : [];
                   exStatus((n > 0 ? `${m.name} added — ${n} manholes · ${state.chambers.length} on the drawing`
                                   : `${m.name} refreshed in place · ${state.chambers.length} manholes on the drawing`) + runsNote(rs)); })
    .catch(err => alert('The sub-model could not be loaded: ' + err.message));
}
renderExamples();

/** Remove every chamber, obstacle and conduit run — one step Undo takes back. */
function wipeDrawing(){
  state.chambers = []; state.obstacles = []; state.connections = [];
  state.layers = [makeLayer({id:DEFAULT_LAYER, name:'Drawing'})]; state.activeLayer = DEFAULT_LAYER;
  state.sel = null; state.selSet = []; state.pending = null;
  bankCache.clear(); setPendingStatus();
  renderSel(); renderConnections(); renderObstacles(); draw();
}
const drawingEmpty = () => !state.chambers.length && !state.obstacles.length && !state.connections.length;
document.getElementById('btnClear').onclick = () => {
  if (!state.chambers.length || confirm('Remove every chamber, obstacle and conduit run?')) wipeDrawing();
};
document.getElementById('exWipe').onclick = () => {
  if (drawingEmpty()){ exStatus('the drawing is already empty'); return; }
  if (!confirm('Wipe the drawing — remove every chamber, obstacle and conduit run? Undo brings them back.')) return;
  wipeDrawing(); exStatus('drawing wiped — place an example, add a sub-model, or start drawing');
};

/* ==========================================================================
   HISTORY — undo and redo
   The document (chambers, obstacles, runs, specs and the routing settings) is
   snapshotted after every change. A drag is one step; keystrokes into one
   field in quick succession are one step. The view, the selection and the
   open windows are not part of it, so undo never moves the drawing about.
   ========================================================================== */
const HIST = {stack:[], at:-1, max:200, timer:null, applying:false};
let lastInput = {key:null, t:-1e9};
document.addEventListener('input', e => { lastInput = {key: e.target.id || e.target.name || 'field', t: performance.now()}; }, true);
function docSnapshot(){
  return JSON.stringify({
    ground: state.ground, cover: state.cover, avoidChambers: state.avoidChambers, avoidPipes: state.avoidPipes, square: state.square,
    layers: state.layers, activeLayer: state.activeLayer,
    specs: state.specs, chambers: state.chambers, obstacles: state.obstacles,
    connections: state.connections.map(({route, ...rest}) => rest)
  });
}
/** Take a snapshot once the current change has settled (many renders, one mark). */
function historyMark(){
  if (HIST.applying || HIST.timer) return;
  HIST.timer = setTimeout(() => {
    HIST.timer = null;
    if ((drag && drag.kind === 'move') || ROUTE_QUICK) return;       // mid-drag: the step is taken when the pointer lifts
    const snap = docSnapshot(), now = performance.now(), top = HIST.stack[HIST.at];
    if (top && top.s === snap) return;
    const key = now - lastInput.t < 400 ? lastInput.key : null;   // typing into one field merges into one step
    HIST.stack.length = HIST.at + 1;                               // a new change forgets the redo tail
    if (key && top && top.key === key && now - top.t < 1500) HIST.stack[HIST.at] = {s:snap, key, t:now};
    else { HIST.stack.push({s:snap, key, t:now}); if (HIST.stack.length > HIST.max) HIST.stack.shift(); HIST.at = HIST.stack.length - 1; }
    updateHistoryButtons();
  }, 0);
}
function updateHistoryButtons(){
  document.getElementById('btnUndo').disabled = HIST.at <= 0;
  document.getElementById('btnRedo').disabled = HIST.at >= HIST.stack.length - 1;
}
function applySnapshot(s){
  const d = JSON.parse(s);
  HIST.applying = true;
  state.ground = d.ground; state.cover = d.cover; state.avoidChambers = d.avoidChambers; state.avoidPipes = d.avoidPipes; state.square = d.square;
  state.specs = d.specs; state.chambers = d.chambers; state.obstacles = d.obstacles;
  state.layers = Array.isArray(d.layers) && d.layers.length ? d.layers : [makeLayer({id:DEFAULT_LAYER, name:'Drawing'})];
  state.activeLayer = d.activeLayer || DEFAULT_LAYER;
  state.connections = d.connections.map(cn => ({...cn, route:null}));
  const alive = new Set([...state.chambers, ...state.obstacles, ...state.connections].map(x => x.uid));
  state.selSet = state.selSet.filter(x => alive.has(x.id));         // the selection survives where its things do
  state.sel = state.sel && alive.has(state.sel.id) ? state.sel : (state.selSet[0] ? {kind:state.selSet[0].kind, id:state.selSet[0].id} : null);
  if (!state.specs.some(x => x.id === state.editSpec)) state.editSpec = state.specs[0] ? state.specs[0].id : null;
  state.pending = null; setPendingStatus(); closeRadial();
  syncDrawingInputs(); renderSpecs(); renderSpecEdit(); renderSel(); renderConnections(); renderObstacles(); draw();
  HIST.applying = false;
  updateHistoryButtons();
}
function undo(){ if (HIST.at > 0){ HIST.at--; applySnapshot(HIST.stack[HIST.at].s); } }
function redo(){ if (HIST.at < HIST.stack.length - 1){ HIST.at++; applySnapshot(HIST.stack[HIST.at].s); } }
document.getElementById('btnUndo').onclick = undo;
document.getElementById('btnRedo').onclick = redo;

/** Everything selected goes: runs, obstacles, chambers and the runs that touch them. */
function deleteSelection(){
  const set = state.selSet.slice();
  if (!set.length) return;
  const runs = new Set(set.filter(x => x.kind === 'conn').map(x => x.id));
  const chs = new Set(set.filter(x => x.kind === 'chamber').map(x => x.id));
  const obs = new Set(set.filter(x => x.kind === 'obstacle').map(x => x.id));
  state.connections = state.connections.filter(c => !runs.has(c.uid) && !chs.has(c.a.mh) && !chs.has(c.b.mh));
  state.chambers = state.chambers.filter(c => !chs.has(c.uid));
  state.obstacles = state.obstacles.filter(o => !obs.has(o.uid));
  state.pending = null; setPendingStatus(); select(null);
}
document.addEventListener('keydown', e => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
  if (e.key === 'Escape' && !RADIAL.hidden){ closeRadial(); return; }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z'){ e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'y'){ e.preventDefault(); redo(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace'){
    if (!state.selSet.length) return;
    e.preventDefault();
    deleteSelection();
  } else if (e.key === 'Escape'){ state.pending = null; setPendingStatus(); select(null); }
  else if (e.key === 'f' || e.key === 'F'){ fitView(); }
  else if (e.key === '3'){ setView3d(!state.view3d); }
  else if (e.key.startsWith('Arrow') && movables().length){
    e.preventDefault();
    const d = (state.snap || 10) * (e.shiftKey ? 10 : 1);
    for (const o of movables()){
      if (e.key === 'ArrowLeft')  o.x -= d;
      if (e.key === 'ArrowRight') o.x += d;
      if (e.key === 'ArrowUp')    o.y += d;
      if (e.key === 'ArrowDown')  o.y -= d;
    }
    renderSel(); renderConnections(); draw();
  }
});

new ResizeObserver(() => draw()).observe(STAGE);

/* ==========================================================================
   START
   ========================================================================== */

state.specs = [
  makeSpec({name:'MV',        colour:'#e0655f', radius:100, bendR:1800, stub:600, minLeg:600, buffer:600, spacing:600, warnAngle:45, angles:[11.25,22.5,45], enc:100}),
  makeSpec({name:'LV',        colour:'#f0a35e', radius:75,  bendR:1200, stub:500, minLeg:500, buffer:300, spacing:450, warnAngle:45, angles:[11.25,22.5,45,90]}),
  makeSpec({name:'ELV',       colour:'#35c3e8', radius:50,  bendR:900,  stub:400, minLeg:400, buffer:200, spacing:300, warnAngle:90, angles:[22.5,45,90]}),
  makeSpec({name:'FIBRE',     colour:'#6bd68a', radius:50,  bendR:900,  stub:400, minLeg:400, buffer:200, spacing:300, warnAngle:45, angles:[11.25,22.5,45,90]}),
  makeSpec({name:'TELECOMMS', colour:'#d8a0e0', radius:50,  bendR:900,  stub:400, minLeg:400, buffer:200, spacing:300, warnAngle:90, angles:[22.5,45,90]})
];
state.editSpec = state.specs[0].id;

state.chambers = [
  makeChamber({ref:'MH01', x:0,     y:0,    intX:1200, intY:1200, wall:150}),
  makeChamber({ref:'MH02', x:12000, y:0,    intX:1500, intY:1500, wall:200}),
  makeChamber({ref:'MH03', x:22000, y:4500, intX:1200, intY:1200, wall:150, rot:45})
];
state.obstacles = [ makeObstacle({name:'OBS01', x:6000, y:0, w:2400, d:3600, rot:0, buffer:250}) ];
state.connections = [
  {uid:uid(), a:{mh:state.chambers[0].uid, face:'B'}, b:{mh:state.chambers[1].uid, face:'D'},
   placed:true,  level:0, specId:state.specs[1].id, route:null},
  {uid:uid(), a:{mh:state.chambers[0].uid, face:'B'}, b:{mh:state.chambers[1].uid, face:'D'},
   placed:true,  level:0, specId:state.specs[3].id, route:null},
  {uid:uid(), a:{mh:state.chambers[1].uid, face:'B'}, b:{mh:state.chambers[2].uid, face:'D'},
   placed:false, level:0, specId:state.specs[0].id, route:null}
];

renderSpecs(); renderSpecEdit(); renderSel(); renderConnections(); renderObstacles(); fitView();
DEMO_DOC = docSnapshot();
