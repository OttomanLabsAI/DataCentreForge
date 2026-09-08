/* ==========================================================================
   MANHOLE PLAN
   Square chambers with wall thickness, rectangular obstacles, and conduit runs
   routed internal face to internal face under a named conduit spec: bore, bend
   radius, minimum straight and the bend angles the spec permits.
   Units: millimetres. World axes: +X east, +Y north.
   ========================================================================== */

const SVG = document.getElementById('svg');
const STAGE = document.getElementById('stage');

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
  view: {tx:0, ty:0, s:0.04},
  sel: null,            // {kind:'chamber'|'obstacle'|'conn', id}
  editSpec: null,
  hoverFace: null,
  mode: 'select',
  pending: null,
  snap: 50,
  showGrid: true, showDims: true, avoidChambers: true, avoidPipes: true, square: true,
  ground: 0, cover: 500,        // ground level and the least cover over any conduit
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

/* ---------- model --------------------------------------------------------- */

function makeChamber(o = {}){
  return Object.assign({uid:uid(), ref:nextRef(), x:0, y:0, intX:1200, intY:1200, wall:150, rot:0, buffer:300, latSpace:450, zSpace:300, edgeClear:150,
                        z0:-600, zLid:0, zBase:-1800}, o);
}
function makeObstacle(o = {}){
  return Object.assign({uid:uid(), name:nextName(), x:0, y:0, w:2400, d:2400, rot:0, buffer:250,
                        zTop:0, zBot:-1500, around:true, over:true, under:true}, o);
}
/* How a conduit may pass an obstacle: AROUND it (its footprint is a plan
   keep-out), OVER it or UNDER it. Around always comes first; a run crosses
   an around-obstacle only when nothing gets round it. Of the two crossings,
   under is the default and over the fallback. One allowing nothing at all is
   simply impassable. */
const obsCrossable  = o => !!(o.over || o.under);
const obsBlocksPlan = o => !!o.around || !obsCrossable(o);
const obsRules = o => ['around','over','under'].filter(k => o[k]).join(' · ') || 'impassable';
const obsRulesShort = o => o.around && o.over && o.under ? 'any way'
  : ['around','over','under'].filter(k => o[k]).join('/') || 'impassable';
const chamberZ0 = c => Number.isFinite(c.z0) ? c.z0 : -600;
const chamberZs = c => [Number.isFinite(c.zBase) ? c.zBase : -1800, Number.isFinite(c.zLid) ? c.zLid : 0];   // [base, lid]
function makeSpec(o = {}){
  return Object.assign({
    id:uid(), name:'New spec', colour:SPEC_COLOURS[state.specs.length % SPEC_COLOURS.length],
    radius:150, bendR:600, stub:500, minLeg:500, buffer:300, spacing:300, warnAngle:45, angles:[22.5,45,90]
  }, o);
}
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
const BEND_COST = 1500, ANGLE_COST = 4000, RADIUS_COST = 3000;
/* Straights are king: run length spent OFF the run's own axes (the directions
   it leaves and enters the manholes on) is charged this multiplier, so the
   router steps aside briefly and runs straight, instead of sailing off on a
   long diagonal or tenting over an obstacle. */
const OFF_AXIS_COST = 1.6;
/* A pair of faces this close to square-on (about 2°) takes one straight duct
   between the entry points instead of a detour of fittings — so a chamber a
   snap-step out of line still routes dead straight. */
const SKEW_TAN = Math.tan(2*D2R);
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
function candidates(P, d0, V, turns, lo, fine, ext){
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
    if (dot >= lo[0] && Math.abs(cr) <= Math.max(1, dot*SKEW_TAN))
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

function search(P, d0, V, delta, signed, spec, blockers, strict){
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
      + ANGLE_COST*f.warnings.filter(w => w.kind === 'angle').length
      + RADIUS_COST*f.warnings.filter(w => w.kind === 'radius').length;
  };
  const evalCands = (seq, fine) => {
    const m = seq.length + 1, ext = Array(m).fill(0);
    if (seq.length){
      const T = t => spec.bendR * Math.tan(Math.abs(t)*D2R/2);
      ext[0] = T(seq[0]); ext[m-1] = T(seq[seq.length-1]);
    }
    for (const sol of candidates(P, d0, V, seq, segMins(seq, spec, strict), fine, ext)){
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
    if (n > 0 && !signed.length) break;
    if (best && straightLine + BEND_COST*n >= best.score) break;
    for (const seq of sequences(signed, delta, n)){
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
function solveRoute(P, d0, Q, d2, spec, blockers){
  const V = [Q[0]-P[0], Q[1]-P[1]];
  const delta = signedAngle(d0, d2);
  const angles = [...new Set(spec.angles)].filter(a => a > 0 && a < 180).sort((a,b) => a-b);
  const signed = []; for (const a of angles) signed.push(a, -a);

  /* One search with relaxed minimums: geometry honouring the full bend radius
     carries no cut and wins on score; tight spots take a scored radius cut
     instead of being unreachable behind a strict-pass shortcut. */
  const relaxed = search(P, d0, V, delta, signed, spec, blockers, false);
  if (relaxed.ok) return relaxed;
  return {ok:false, msg: relaxed.sawBlocked ? 'blocked — no way past the keep-outs'
    : relaxed.sawSolution ? 'no room — shorten the minimum straights'
    : angles.length ? 'no route to that face with these angles' : 'allow a bend angle'};
}

function faceRuns(mhUid, face){
  return state.connections.filter(c =>
    (c.a.mh === mhUid && c.a.face === face) || (c.b.mh === mhUid && c.b.face === face));
}
/** Where a run actually meets the chamber: runs sharing a face are spread
    along it at the manhole's lateral spacing, ordered so the run heading
    left takes the left slot and entries never cross at the wall. */
const runCols = r => Math.max(1, r.cols|0 || 1);
const runRows = r => Math.max(1, r.rows|0 || 1);

/** Everything about how a face carries its conduits: one shared grid whose
    pitch is the LARGEST array spacing among the types present (floored by
    the manhole's lateral spacing), arrays tiling it in canonical order,
    stacked by level (level 0 highest). Used by plan entries, the face
    section view, and the width check — so they always agree. */
function faceLayout(mhUid, face){
  const c = byUid(mhUid);
  if (!c) return null;
  const g = faceGeom(c, face);
  const runs = faceRuns(mhUid, face);
  /* canonical world-direction tangent, matching the banks */
  let t = norm([g.p2[0]-g.p1[0], g.p2[1]-g.p1[1]]);
  if (t[1] < -1e-9 || (Math.abs(t[1]) <= 1e-9 && t[0] < 0)) t = [-t[0], -t[1]];
  /* a conduit window imported from Revit replaces the face-width-less-edge rule:
     its centre may sit off the face centre, measured along the face's local axis */
  const win = c.win && c.win[face] ? c.win[face] : null;
  let shift = 0;
  if (win){
    const lax = (face === 'A' || face === 'C') ? rotv([1,0], c.rot) : rotv([0,1], c.rot);
    shift = win.off * (Math.sign(lax[0]*t[0] + lax[1]*t[1]) || 1);
  }
  if (!runs.length) return {c, g, t, S:c.latSpace, groups:[], usedW:0, rowsTotal:0, fits:true, win, shift};
  const S = Math.max(c.latSpace, ...runs.map(r => specOf(r) ? (specOf(r).spacing || 0) : 0));
  const order = rs => rs.map(r => {
    const far = (r.a.mh === mhUid && r.a.face === face) ? r.b : r.a;
    const oc = byUid(far.mh);
    return {r, proj: oc ? (oc.x-g.mid[0])*t[0] + (oc.y-g.mid[1])*t[1] : 0};
  }).sort((x,y) => x.proj - y.proj || (x.r.uid < y.r.uid ? -1 : 1)).map(k => k.r);
  const levels = [...new Set(runs.map(r => r.level|0))].sort((a,b) => a-b);
  const groups = [];
  let rowsTotal = 0, usedW = 0;
  for (const lv of levels){
    const rs = order(runs.filter(r => (r.level|0) === lv));
    let col = 0; const items = [];
    for (const r of rs){
      items.push({cn:r, sp:specOf(r), cols:runCols(r), rows:runRows(r), colStart:col});
      col += runCols(r);
    }
    const totalCols = col;
    const rMax = Math.max(...items.map(i => i.sp ? i.sp.radius : 0));
    const rowsMax = Math.max(...items.map(i => i.rows));
    for (const i of items) i.centreOff = (i.colStart + (i.cols-1)/2 - (totalCols-1)/2) * S + shift;
    groups.push({level:lv, items, totalCols, rMax, rowsMax});
    rowsTotal += rowsMax;
    usedW = Math.max(usedW, (totalCols-1)*S + 2*rMax);
  }
  const fits = win ? usedW <= win.w + 1 : usedW + 2*(c.edgeClear || 0) <= g.width + 1;
  return {c, g, t, S, groups, usedW, rowsTotal, fits, win, shift};
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
    const zDn = Math.max(...members.map(cn => ((cn.level|0) + runRows(cn) - 1) * zPitch));
    const g = {
      key, members, ends, A, B, start, finish,
      PS:[gS.mid[0]+tS[0]*meanS, gS.mid[1]+tS[1]*meanS],
      PE:[gE.mid[0]+tE[0]*meanE, gE.mid[1]+tE[1]*meanE],
      d0:[gS.n[0], gS.n[1]], d2:[-gE.n[0], -gE.n[1]],
      maxOff,
      maxRad: Math.max(...specs.map(sp => sp.radius)),
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
  let sPair = G.maxRad + H.maxRad + Math.max(G.maxBuf, H.maxBuf);
  for (const u of [G.start.mh, G.finish.mh]){
    if (u !== H.start.mh && u !== H.finish.mh) continue;
    const c = byUid(u);
    if (c) sPair = Math.min(sPair, Math.max(G.maxRad + H.maxRad, c.latSpace - 1));
  }
  return sPair;
}
const levelsMeet = (G, H) => [...G.levels].some(l => H.levels.has(l));

/** Plan keep-outs for a bank. Obstacles that may be crossed over or under
    (and need not be gone round) are not keep-outs at all; those in `allow`
    are the around-obstacles the run has been permitted to cross because
    nothing gets round them. */
function bankBlockers(G, banks, allow){
  const out = [];
  const pad = G.maxOff + G.maxRad;
  for (const o of state.obstacles){
    if (!obsBlocksPlan(o) || (allow && allow.has(o.uid))) continue;
    out.push({type:'box', cx:o.x, cy:o.y, rot:o.rot, hw:o.w/2, hh:o.d/2,
              margin: pad + Math.max(G.maxBuf, o.buffer)});
  }
  if (state.avoidChambers)
    for (const c of state.chambers){
      if (c.uid === G.start.mh || c.uid === G.finish.mh) continue;
      out.push({type:'box', cx:c.x, cy:c.y, rot:c.rot, hw:c.intX/2+c.wall, hh:c.intY/2+c.wall,
                margin: pad + Math.max(G.maxBuf, c.buffer)});
    }
  if (state.avoidPipes)
    for (const H of banks){
      if (H === G || !H.anyPlaced || !H.route || !H.route.ok) continue;
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
  const box = o => [o.x, o.y, o.w, o.d, o.rot, o.buffer, o.zTop, o.zBot, !!o.around, !!o.over, !!o.under];
  const mh  = c => [c.x, c.y, c.intX, c.intY, c.wall, c.rot, c.buffer, c.latSpace, c.zSpace, chamberZ0(c)];
  const others = state.avoidPipes ? banks
    .filter(H => H !== G && H.anyPlaced && H.route && H.route.ok && levelsMeet(G, H))
    .map(H => [H.key, H.maxOff, H.maxRad, H.maxBuf, H.spec.stub,
               H.route.poly.map(p => [Math.round(p[0]/10), Math.round(p[1]/10)])]) : 0;
  return JSON.stringify([G.key, G.PS.map(Math.round), G.PE.map(Math.round),
    G.ends.map(e => [Math.round(e.w0), Math.round(e.w1), Math.round(e.halfW)]), [...G.levels], G.spec, Math.round(G.maxOff), G.zUp, G.zDn,
    state.avoidChambers, state.avoidPipes, ROUTE_QUICK, state.ground, state.cover,
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
  const P = rt.poly, {cum, k} = chainage(rt), reachBase = G.maxOff + G.maxRad;
  const STEP = 25, out = [];
  for (const o of state.obstacles){
    if (!obsCrossable(o)) continue;
    const reach = reachBase + Math.max(G.maxBuf, o.buffer);
    let s0 = Infinity, s1 = -Infinity;
    for (let i = 0; i < P.length-1; i++){
      const L = cum[i+1]-cum[i], n = Math.max(1, Math.ceil(L/STEP));
      for (let j = 0; j <= n; j++){
        const t = j/n, p = [P[i][0] + (P[i+1][0]-P[i][0])*t, P[i][1] + (P[i+1][1]-P[i][1])*t];
        if (boxDist(p, o) < reach){ const s = cum[i] + L*t; s0 = Math.min(s0, s); s1 = Math.max(s1, s); }
      }
    }
    if (s0 <= s1) out.push({o, s0: Math.max(0, (s0-STEP)*k), s1: Math.min(rt.length, (s1+STEP)*k)});
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
  pf.S = S; pf.zA = zA; pf.zB = zB;
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
  const ceiling = state.ground - state.cover - G.maxRad;      // highest the top lane may run
  const chord = s => zA + (zB-zA)*s/S, chordLen = Math.hypot(S, zB-zA);
  const info = xs.map(x => {
    const top = Math.max(x.o.zTop, x.o.zBot) + lift, bot = Math.min(x.o.zTop, x.o.zBot);
    const margin = G.maxRad + Math.max(G.maxBuf, x.o.buffer);
    const needOver = top + margin + 1, needUnder = bot - margin - 1;     // a hair clear of the keep-out
    const clearOver  = x.o.over  && chord(x.s0) >= needOver  && chord(x.s1) >= needOver;
    const clearUnder = x.o.under && chord(x.s0) <= needUnder && chord(x.s1) <= needUnder;
    return {x, top, bot, margin, needOver, needUnder, free: clearOver || clearUnder,
            canOver: !!x.o.over && needOver <= ceiling, canUnder: !!x.o.under};
  });
  const boxes = info.map(i => ({type:'box', cx:(i.x.s0+i.x.s1)/2, cy:(i.bot+i.top)/2, rot:0,
                                hw:Math.max(0, (i.x.s1-i.x.s0)/2 - i.margin), hh:(i.top-i.bot)/2, margin:i.margin}));
  const noBack = f => f.pts.every((p, i) => i === 0 || p[0] >= f.pts[i-1][0] - 1e-6);
  const angles = [...vs.angles].filter(a => a > 0 && a < 180);
  const order = [...angles.filter(a => a <= (vs.warnAngle || 999)).sort((a,b) => b-a),
                 ...angles.filter(a => a > (vs.warnAngle || 999)).sort((a,b) => b-a)];
  const todo = info.filter(i => !i.free);

  /* by construction: one flat under (or over) every crossing that needs it */
  const built = mode => {
    if (!todo.length) return null;
    if (todo.some(i => mode === 'under' ? !i.canUnder : !i.canOver)) return null;
    const zFlat = mode === 'under' ? Math.min(zA, zB, ...todo.map(i => i.needUnder))
                                   : Math.max(zA, zB, ...todo.map(i => i.needOver));
    if (mode === 'over' && zFlat > ceiling) return null;
    const bands = todo.map(i => [i.x.s0, i.x.s1]);      // already widened by the clearance in plan
    for (const compound of [false, true])
      for (const th of order){
        const f = buildDip(vs, S, zA, zB, zFlat, bands, th, zones, compound);
        if (!f || !noBack(f) || !clearOf(f.poly, boxes)) continue;
        return profileWarn(f, compound ? compoundBends(f, zones) : []);
      }
    return null;
  };
  if (todo.length){
    const under = built('under'), over = built('over');
    const dev = f => f ? f.length - chordLen : Infinity;
    const pick = under && over ? (dev(over) < dev(under) - 1 ? over : under) : (under || over);
    if (pick) return finishProfile(pick, xs, S, zA, zB, lift);
  }

  /* by search: the plan engine in the (chainage, z) plane, first keeping off
     the plan's bends, then allowing compound bends */
  const BIG = 1e7;
  const modesFor = i => i.free ? [null] : [...(i.canUnder ? ['under'] : []), ...(i.canOver ? ['over'] : [])];
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
  const names = todo.map(i => i.x.o.name).join(', ');
  if (!todo.length) return {ok:false, msg:'no way to change level in section'};
  const ways = todo.map(i => (i.canUnder ? 'under' : '') + (i.canUnder && i.canOver ? ' or ' : '') + (i.canOver ? 'over' : ''));
  return {ok:false, msg: ways.every(w => !w) ? `no way past ${names} — over would break the ground cover`
                                             : `no way ${ways[0] || 'past'} ${names} in section`};
}
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

/** Plan first, going round everything it must. When nothing gets round, the
    run is allowed through the around-obstacles that may be crossed, then
    re-routed with every obstacle it did not need put back as a keep-out,
    until the set it crosses stops shrinking. Then the section. */
function solveBank(G, banks){
  let rt = solveRoute(G.PS, G.d0, G.PE, G.d2, G.spec, bankBlockers(G, banks, null));
  if (!rt.ok){
    let allow = new Set(state.obstacles.filter(o => obsBlocksPlan(o) && obsCrossable(o)).map(o => o.uid));
    for (let i = 0; i < 4 && allow.size; i++){
      const r2 = solveRoute(G.PS, G.d0, G.PE, G.d2, G.spec, bankBlockers(G, banks, allow));
      if (!r2.ok) break;
      rt = r2;
      const crossed = new Set(routeCrossings(G, r2).map(x => x.o.uid).filter(u => allow.has(u)));
      if (crossed.size === allow.size) break;
      allow = crossed;
    }
    if (!rt.ok) return rt;
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
    r.warnings = G.route.warnings.filter(w => w.kind === 'radius').map(w => ({...w}));
    r.turns.forEach((t, i) => {
      if (sp.warnAngle && Math.abs(t) > sp.warnAngle + 1e-6)
        r.warnings.push({kind:'angle', bend:i+1,
          text:`bend ${i+1} — ${fmt1(Math.abs(t))}° is over the ${fmt1(sp.warnAngle)}° limit`});
    });
    /* the section: the bank profile dropped to this member's level */
    let pf = G.route.profile ? memberProfile(G.route.profile, (cn.level|0)*G.zPitch - G.zUp) : null;
    if (pf && e.se !== 'a') pf = reversedProfile(pf);
    r.profile = pf;
    r.crossings = pf ? pf.crossings : [];
    r.leadLane = e === G.ends[0];        // the lane that carries the bank's crossing labels
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
      G.route = solveBank(G, banks);
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
  if (!state.avoidPipes || !banks) return;
  const live = banks.filter(G => G.anyPlaced && G.route && G.route.ok);
  for (let i = 0; i < live.length; i++) for (let j = i+1; j < live.length; j++){
    const G = live[i], H = live[j];
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
    state.view = {tx:r.width/2, ty:r.height/2, s:0.05}; return state.view3d ? fit3d() : draw();
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
  if (state.view3d) fit3d(); else draw();
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
  if (state.view3d) return draw3d();
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

  for (const o of state.obstacles) out.push(drawObstacle(o));
  for (const cn of state.connections) out.push(drawConnection(cn));

  for (const c of state.chambers){
    const inner = corners(c, 0), outer = corners(c, c.wall);
    const on = selIs('chamber') && state.sel.id === c.uid;
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

  SVG.setAttribute('viewBox', `0 0 ${W} ${H}`);
  SVG.innerHTML = out.join('');
  drawScaleBar();
  document.getElementById('rz').textContent = (state.view.s*100).toFixed(1) + ' px/cm';
}

function drawObstacle(o){
  const on = selIs('obstacle') && state.sel.id === o.uid;
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
      out.push(`<text x="${ctr[0]}" y="${ctr[1]+17}" fill="${C.inkDim}" font-family="${C.mono}" font-size="9.5" text-anchor="middle">${esc(obsRules(o))}</text>`);
  }
  return out.join('');
}

function drawConnection(cn){
  const A = byUid(cn.a.mh), B = byUid(cn.b.mh);
  if (!A || !B) return '';
  const s = state.view.s, sp = specOf(cn), rt = cn.route;
  const on = selIs('conn') && state.sel.id === cn.uid;
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
  if (on && sp.buffer > 0)
    out.push(`<path d="${lanes[Math.floor(cols/2)]}" fill="none" stroke="${sp.colour}" stroke-width="${2*(halfW+sp.radius+sp.buffer)*s}" stroke-linejoin="round" stroke-linecap="round" opacity=".09"/>`);
  for (const ld of lanes){
    out.push(`<path d="${ld}" fill="none" stroke="${edge}" stroke-width="${body}" stroke-linejoin="round" stroke-linecap="butt" opacity=".95"/>`);
    if (body > 4) out.push(`<path d="${ld}" fill="none" stroke="${C.pipeBody}" stroke-width="${body-2.4}" stroke-linejoin="round" stroke-linecap="butt"/>`);
  }
  out.push(`<path d="${d}" fill="none" stroke="${edge}" stroke-width="1" stroke-dasharray="9 4 2 4" opacity=".8"/>`);
  out.push(`<circle cx="${p[0]}" cy="${p[1]}" r="3.2" fill="${edge}"/><circle cx="${q[0]}" cy="${q[1]}" r="3.2" fill="${edge}"/>`);

  const flagged = new Set(rt.warnings.map(w => w.bend));
  rt.fillets.forEach((f,i) => {
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
    out.push(`<text x="${m[0]}" y="${m[1]-body/2-7}" fill="${edge}" font-family="${C.mono}" font-size="10.5" text-anchor="middle">${metres(rt.length3d || rt.length)}${lvl}</text>`);
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
function run3d(cn){
  const rt = cn.route, out = [];
  if (!rt || !rt.ok) return out;
  const pf = rt.profile, A = byUid(cn.a.mh), B = byUid(cn.b.mh);
  const cols = runCols(cn), rows = runRows(cn);
  const S = Math.max(entryFor(cn,'a').S || 0, entryFor(cn,'b').S || 0);
  const zPitch = Math.max(1, A ? A.zSpace : 0, B ? B.zSpace : 0);
  const zFlat = chamberZ0(A) - (cn.level|0)*zPitch;
  for (let k = 0; k < cols; k++){
    const w = (k - (cols-1)/2) * S;
    let lane = rt;
    if (Math.abs(w) > 1e-6){ try { lane = offsetMember(rt, w, w); } catch(_){ lane = rt; } }
    const {cum, k:kk} = chainage(lane), L = lane.length || 1, PS = pf ? (pf.S || L) : L;
    const ss = cum.map(v => v*kk);
    if (pf) for (const q of pf.poly) ss.push(q[0]*L/PS);
    const sorted = [...new Set(ss.map(v => Math.round(v*10)/10))].filter(v => v >= 0 && v <= L + 1e-6).sort((a,b) => a-b);
    const line = sorted.map(v => { const q = pointAt(lane, v); return [q[0], q[1], pf ? profileZ(pf, v*PS/L) : zFlat]; });
    for (let rI = 0; rI < rows; rI++) out.push(rI ? line.map(q => [q[0], q[1], q[2] - rI*zPitch]) : line);
  }
  return out;
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
  const r = STAGE.getBoundingClientRect(); stageW = r.width; stageH = r.height;
  const cam = state.cam, pts = [];
  for (const c of state.chambers){ const [zb, zl] = chamberZs(c); for (const p of corners(c, c.wall)) pts.push([p[0], p[1], zb], [p[0], p[1], zl]); }
  for (const o of state.obstacles) for (const p of boxCorners(o, 0)) pts.push([p[0], p[1], Math.min(o.zTop, o.zBot)], [p[0], p[1], Math.max(o.zTop, o.zBot)]);
  for (const cn of state.connections) if (cn.placed && cn.route && cn.route.ok) for (const line of run3d(cn)) pts.push(...line);
  if (!pts.length){ Object.assign(cam, {cx:0, cy:0, cz:0, s:0.03, px:0, py:0}); return draw(); }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let i = 0; i < 3; i++){ lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
  cam.cx = (lo[0]+hi[0])/2; cam.cy = (lo[1]+hi[1])/2; cam.cz = (lo[2]+hi[2])/2;
  cam.s = 1; cam.px = 0; cam.py = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts){ const q = proj(p); x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
  cam.s = Math.max(0.0005, Math.min(3, Math.min((r.width-2*pad)/Math.max(1, x1-x0), (r.height-2*pad)/Math.max(1, y1-y0))));
  cam.px = -((x0+x1)/2 - r.width/2)*cam.s;
  cam.py = -((y0+y1)/2 - r.height/2)*cam.s;
  draw();
}

function draw3d(){
  const r = STAGE.getBoundingClientRect(); stageW = r.width; stageH = r.height;
  const cam = state.cam, s = cam.s, prims = [], out = [];
  const fp = q => q[0].toFixed(1) + ',' + q[1].toFixed(1);
  const polyStr = qs => qs.map(fp).join(' ');
  const line = (a, b, attrs) => `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" ${attrs}/>`;
  const isOn = (kind, id) => !!state.sel && state.sel.kind === kind && state.sel.id === id;

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
  for (const o of state.obstacles){
    const on = isOn('obstacle', o.uid), zb = Math.min(o.zTop, o.zBot), zt = Math.max(o.zTop, o.zBot);
    box(boxCorners(o, 0), zb, zt, C.obsFill, .92, on ? C.sel : C.obsLine, on ? 1.8 : 1.1, {kind:'obstacle', id:o.uid}, true);
    if (Math.min(o.w, o.d)*s > 30) label([o.x, o.y, zt], o.name, on ? C.sel : C.obsLine);
  }
  for (const c of state.chambers){
    const on = isOn('chamber', c.uid), [zb, zl] = chamberZs(c);
    box(corners(c, c.wall), zb, zl, C.chamber, .94, on ? C.sel : C.ink, on ? 1.8 : 1.1, {kind:'chamber', id:c.uid});
    if ((c.intX + 2*c.wall)*s > 30) label([c.x, c.y, zl], c.ref, on ? C.sel : C.ink, 12);
  }

  /* conduits: every column and row of every run, segment by segment */
  for (const cn of state.connections){
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

  SVG.setAttribute('viewBox', `0 0 ${stageW} ${stageH}`);
  SVG.innerHTML = out.join('') + prims.map(p => p.svg).join('') + tri.join('');
  prims3d = prims;
  drawScaleBar(s);
  document.getElementById('rz').textContent = (s*100).toFixed(1) + ' px/cm';
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
           pan:e.shiftKey || e.button === 1, moved:false};
}
function pointer3dMove(e, sp){
  if (!drag3){ STAGE.style.cursor = pick3d(sp) ? 'pointer' : 'grab'; return; }
  const dx = sp[0]-drag3.sx, dy = sp[1]-drag3.sy;
  if (Math.hypot(dx, dy) > 3) drag3.moved = true;
  if (drag3.pan){ state.cam.px = drag3.px + dx; state.cam.py = drag3.py + dy; }
  else { state.cam.az = drag3.az - dx*0.4; state.cam.el = Math.max(5, Math.min(89.5, drag3.el + dy*0.4)); }
  STAGE.style.cursor = drag3.pan ? 'move' : 'grabbing';
  draw();
}
function pointer3dUp(sp){
  if (drag3 && !drag3.moved){ const h = pick3d(sp); select(h ? h.kind : null, h ? h.id : null); }
  drag3 = null;
  STAGE.style.cursor = 'grab';
}
function setView3d(on){
  state.view3d = on;
  document.getElementById('btnView3d').classList.toggle('on', on);
  state.hoverFace = null; showCallout(null);
  if (on && state.mode === 'connect') btnConnect.onclick();       // connecting faces is a plan-view job
  document.getElementById('rmode').textContent = on ? '3D — drag to orbit · shift-drag to pan · scroll to zoom · click to select' : '';
  STAGE.style.cursor = on ? 'grab' : 'crosshair';
  if (on) fit3d(); else draw();
}

/* ==========================================================================
   HIT TESTING
   ========================================================================== */

function hitFace(world, tolPx = 9){
  const tol = tolPx/state.view.s;
  let best = null, bestD = Infinity;
  for (const c of state.chambers) for (const f of FACES){
    const g = faceGeom(c, f), d = distToSeg(world, g.p1, g.p2);
    if (d < tol && d < bestD){ bestD = d; best = {mh:c.uid, face:f}; }
  }
  return best;
}
function hitChamber(w){
  for (let i = state.chambers.length-1; i >= 0; i--)
    if (pointInPoly(w, corners(state.chambers[i], state.chambers[i].wall))) return state.chambers[i];
  return null;
}
function hitObstacle(w){
  for (let i = state.obstacles.length-1; i >= 0; i--)
    if (pointInPoly(w, boxCorners(state.obstacles[i], 0))) return state.obstacles[i];
  return null;
}
function hitConnection(w, tolPx = 8){
  let best = null, bestD = Infinity;
  for (const cn of state.connections){
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

STAGE.addEventListener('pointerdown', e => {
  if (e.button === 2) return;
  e.preventDefault();                       // stop native text selection while dragging
  STAGE.setPointerCapture(e.pointerId);
  const r = STAGE.getBoundingClientRect();
  const sp = [e.clientX-r.left, e.clientY-r.top], wp = S2W(sp);
  if (state.view3d){ pointer3dDown(e, sp); return; }

  if (state.mode === 'connect'){
    const f = hitFace(wp, 12);
    if (f) pickFace(f); else { state.pending = null; draw(); }
    return;
  }
  const c = hitChamber(wp);
  if (c){ select('chamber', c.uid); drag = {kind:'move', obj:c, dx:wp[0]-c.x, dy:wp[1]-c.y}; ROUTE_QUICK = true; return; }
  const o = hitObstacle(wp);
  if (o){ select('obstacle', o.uid); drag = {kind:'move', obj:o, dx:wp[0]-o.x, dy:wp[1]-o.y}; ROUTE_QUICK = true; return; }
  const cn = hitConnection(wp);
  if (cn){ select('conn', cn.uid); return; }
  select(null);
  drag = {kind:'pan', sx:sp[0], sy:sp[1], tx:state.view.tx, ty:state.view.ty};
});

STAGE.addEventListener('pointermove', e => {
  const r = STAGE.getBoundingClientRect();
  const sp = [e.clientX-r.left, e.clientY-r.top], wp = S2W(sp);
  if (state.view3d){
    document.getElementById('rx').textContent = '—';
    document.getElementById('ry').textContent = '—';
    return pointer3dMove(e, sp);
  }
  document.getElementById('rx').textContent = fmt(wp[0]);
  document.getElementById('ry').textContent = fmt(wp[1]);

  if (drag && drag.kind === 'pan'){
    state.view.tx = drag.tx + (sp[0]-drag.sx);
    state.view.ty = drag.ty + (sp[1]-drag.sy);
    return draw();
  }
  if (drag && drag.kind === 'move'){
    drag.obj.x = snap(wp[0]-drag.dx); drag.obj.y = snap(wp[1]-drag.dy);
    renderSel(); renderConnections(); return draw();
  }
  const f = hitFace(wp);
  const changed = JSON.stringify(f) !== JSON.stringify(state.hoverFace);
  state.hoverFace = f;
  showCallout(f, sp);
  STAGE.style.cursor = state.mode === 'connect' ? (f ? 'pointer' : 'crosshair')
    : (hitChamber(wp) || hitObstacle(wp)) ? 'move' : hitConnection(wp) ? 'pointer' : 'crosshair';
  if (changed) draw();
});

STAGE.addEventListener('pointerup', e => {
  if (state.view3d){ const r = STAGE.getBoundingClientRect(); pointer3dUp([e.clientX-r.left, e.clientY-r.top]); return; }
  drag = null;
  if (ROUTE_QUICK){ ROUTE_QUICK = false; renderSel(); renderConnections(); draw(); }
});
STAGE.addEventListener('pointerleave', () => {
  if (state.view3d){ drag3 = null; return; }
  state.hoverFace = null; showCallout(null); draw();
  document.getElementById('rx').textContent = '—';
  document.getElementById('ry').textContent = '—';
});
STAGE.addEventListener('contextmenu', e => e.preventDefault());
STAGE.addEventListener('wheel', e => {
  e.preventDefault();
  const r = STAGE.getBoundingClientRect();
  const sp = [e.clientX-r.left, e.clientY-r.top], before = S2W(sp);
  if (state.view3d){
    const cam = state.cam, ns = Math.max(0.0004, Math.min(4, cam.s*Math.exp(-e.deltaY*0.0016))), g = ns/cam.s;
    cam.px = sp[0] - r.width/2 - (sp[0] - r.width/2 - cam.px)*g;   // keep the point under the cursor still
    cam.py = sp[1] - r.height/2 - (sp[1] - r.height/2 - cam.py)*g;
    cam.s = ns;
    return draw();
  }
  state.view.s = Math.max(0.0004, Math.min(4, state.view.s*Math.exp(-e.deltaY*0.0016)));
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
  renderSel(); renderConnections(); renderObstacles(); draw();
}
function pickFace(f){
  if (!state.pending){ state.pending = f; draw(); return; }
  if (state.pending.mh === f.mh && state.pending.face === f.face){ state.pending = null; draw(); return; }
  const same = (x,y) => x.mh === y.mh && x.face === y.face;
  const dup = state.connections.find(c =>
    (same(c.a, state.pending) && same(c.b, f)) || (same(c.b, state.pending) && same(c.a, f)));
  if (dup){ state.pending = null; select('conn', dup.uid); return; }
  const cn = {uid:uid(), a:state.pending, b:f, placed:false, level:0, rows:1, cols:1,
              specId:(state.editSpec || state.specs[0].id), route:null};
  state.connections.push(cn);
  state.pending = null;
  select('conn', cn.uid);
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
  const box = document.getElementById('connList');
  document.getElementById('connCount').textContent = state.connections.length || '';
  if (!state.connections.length){
    box.innerHTML = `<div class="empty">None yet. Hit <b>Connect faces</b>, then click an internal face on one chamber and an internal face on the next.</div>`;
    return;
  }
  box.innerHTML = '<div class="list">' + state.connections.map(cn => {
    const rt = cn.route, sp = specOf(cn);
    const warn = rt && rt.ok && rt.warnings.length;
    const cls = !rt || !rt.ok ? 'bad' : warn ? 'warn' : cn.placed ? 'ok' : '';
    const meta = !rt || !rt.ok ? 'no route'
               : !cn.placed ? 'not placed'
               : (warn ? '⚠ ' : '') + metres(rt.length3d || rt.length);
    return `<div class="item ${selIs('conn') && state.sel.id === cn.uid ? 'on':''}" data-conn="${cn.uid}">
      <span class="dot" style="background:${sp ? sp.colour : C.inkFaint}"></span>
      <span class="nm">${esc(connLabel(cn))}</span>
      <span class="meta ${cls}">${meta}</span>
      <button class="x" data-del="${cn.uid}" title="Disconnect">×</button></div>`;
  }).join('') + '</div>';
  box.querySelectorAll('[data-conn]').forEach(el => el.onclick = () => select('conn', el.dataset.conn));
  box.querySelectorAll('[data-del]').forEach(b => b.onclick = ev => { ev.stopPropagation(); disconnect(b.dataset.del); });
}

function renderObstacles(){
  const box = document.getElementById('obsList');
  document.getElementById('obsCount').textContent = state.obstacles.length || '';
  if (!state.obstacles.length){
    box.innerHTML = `<div class="empty">None. Add one with <b>+ Obstacle</b> — conduit runs are routed around it, keeping its clearance.</div>`;
    return;
  }
  box.innerHTML = '<div class="list">' + state.obstacles.map(o =>
    `<div class="item ${selIs('obstacle') && state.sel.id === o.uid ? 'on':''}" data-obs="${o.uid}">
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
    cluster('spSpc', 'Spacing & clearance', `clr ${fmt(sp.buffer)} · pitch ${fmt(sp.spacing || 300)}`,
      numRow('sBuf','Clearance', sp.buffer, 50, 'mm') +
      numRow('sSpc','Array spacing', sp.spacing || 300, 25, 'mm')) +
    cluster('spRul', 'Fittings & warnings',
      sp.angles.length ? sp.angles.map(a => fmt1(a)+'°').join(' ') : 'straight only',
      numRow('sWarn','Warn above', sp.warnAngle, 5, '°') +
      `<div class="row" style="margin-top:4px"><label>Bend angles allowed</label></div>
       <div class="chips" id="sAngles">${ANGLE_OPTIONS.map(a =>
          `<button class="chip ${sp.angles.includes(a)?'on':''}" data-ang="${a}">${a}°</button>`).join('')}</div>
       <div class="derived"><b>Bore</b> ${fmt(sp.radius*2)} mm · <b>bend</b> R${fmt(sp.bendR)}<br>
         <b>Straights</b> ≥${fmt(sp.stub)} off face · ≥${fmt(sp.minLeg)} between bends<br>
         <b>Clearance</b> ${fmt(sp.buffer)} each side — pairs keep the larger clearance<br>
         <b>Array pitch</b> ${fmt(sp.spacing || 300)} — faces snap to the largest pitch present<br>
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
  bindS('sStub','stub'); bindS('sLeg','minLeg'); bindS('sBuf','buffer'); bindS('sSpc','spacing'); bindS('sWarn','warnAngle');
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

function renderSel(){
  recomputeRoutes();
  const box = document.getElementById('sel'), ttl = document.getElementById('selTitle');
  if (selIs('chamber')) { ttl.textContent = 'Chamber';  return renderChamberProps(box, byUid(state.sel.id)); }
  if (selIs('obstacle')){ ttl.textContent = 'Obstacle'; return renderObstacleProps(box, obsBy(state.sel.id)); }
  if (selIs('conn'))    { ttl.textContent = 'Conduit run'; return renderRunProps(box, connBy(state.sel.id)); }
  ttl.textContent = 'Selection';
  box.innerHTML = `<div class="empty">Nothing selected. Click a chamber, an obstacle or a conduit run.</div>`;
}

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
         <b>Sides</b> ${FACES.map(f => f+' '+fmt(faceGeom(c,f).width)).join('  ')}</div>`) +
    cluster('chPos', 'Position', `${fmt(c.x)}, ${fmt(c.y)}${c.rot ? ' · ' + fmt1(c.rot) + '°' : ''}`,
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
      numRow('oR','Rotation', o.rot, 15, '°')) +
    cluster('obZ', 'Levels & crossing', `${fmt(Math.max(o.zTop, o.zBot))}…${fmt(Math.min(o.zTop, o.zBot))} · ${obsRulesShort(o)}`,
      numRow('oZT','Top (Z)', o.zTop, 100, 'mm') +
      numRow('oZB','Bottom (Z)', o.zBot, 100, 'mm') +
      `<div class="row" style="margin-top:6px"><label>Conduits may pass</label></div>
       <div class="row"><label class="chk"><input type="checkbox" id="oAround" ${o.around?'checked':''}> around it — its footprint is a keep-out</label></div>
       <div class="row"><label class="chk"><input type="checkbox" id="oOver" ${o.over?'checked':''}> over it</label></div>
       <div class="row"><label class="chk"><input type="checkbox" id="oUnder" ${o.under?'checked':''}> under it</label></div>
       <div class="derived"><span>Around comes first — a run crosses only when nothing gets round. Where both crossings are allowed, the shorter deviation wins (under on a tie), and over never rises into the ground cover. Nothing ticked makes it impassable.</span></div>`) +
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
  for (const [id, key] of [['oAround','around'], ['oOver','over'], ['oUnder','under']])
    document.getElementById(id).onchange = ev => { o[key] = ev.target.checked; renderSel(); renderObstacles(); renderConnections(); draw(); };
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

function renderRunProps(box, cn){
  if (!cn){ box.innerHTML = ''; return; }
  const rt = cn.route, sp = specOf(cn);
  const warns = rt && rt.ok ? rt.warnings : [];
  box.innerHTML =
    `<div class="row"><label style="flex:none" for="qSpec">Conduit spec</label></div>
     <select id="qSpec">${state.specs.map(s =>
       `<option value="${s.id}" ${s.id === cn.specId ? 'selected':''}>${esc(s.name)} — Ø${fmt(s.radius*2)} R${fmt(s.bendR)}</option>`).join('')}</select>
     <div style="height:8px"></div>` +
    cluster('runArr', 'Array & level', `${runCols(cn)} × ${runRows(cn)} · L${cn.level|0}`,
      numRow('qLvl','Level (Z)', cn.level|0, 1, '') +
      numRow('qCols','Columns (wide)', runCols(cn), 1, '') +
      numRow('qRows','Rows (high)', runRows(cn), 1, '')) +
    cluster('runRt', 'Route',
      rt && rt.ok ? metres(rt.length3d || rt.length) + (rt.turns.length ? ` · ${rt.turns.length} bend${rt.turns.length === 1 ? '' : 's'}` : ' · straight')
                    + (rt.profile && rt.profile.turns.length ? ` + ${rt.profile.turns.length} vertical` : '') : 'no route',
      `<div class="derived" style="border-top:none;margin-top:0;padding-top:2px">
         <b>Run</b> ${esc(connLabel(cn))}<br>
         ${entryLine(cn)}${arrayLine(cn)}
         <b>Angles</b> ${sp.angles.length ? sp.angles.map(a => fmt1(a)+'°').join(' · ') : 'straight only'}<br>` +
         (rt && rt.ok
           ? `<b>Bends</b> ${rt.turns.length ? rt.turns.map(t => fmt1(Math.abs(t))+'°').join(' · ') : 'none — straight run'}<br>
              <b>Straight duct</b> ${rt.clear.map(v => fmt(Math.max(0,v))).join(' · ')} mm<br>
              <b>Centreline</b> ${metres(rt.length)} in plan${rt.profile && rt.profile.turns.length ? ` · ${metres(rt.length3d)} laid` : ''}` +
             sectionLines(rt)
           : `<span style="color:${C.bad}">${esc(rt ? rt.msg : '')}</span>`) +
      `</div>`) +
    cluster('runSec', 'Long section', sectionSummary(rt), profileSVG(cn, 232)) +
    (warns.length ? `<div class="alert warn"><b>Check this run</b>${warns.map(w => esc(w.text)).join('<br>')}</div>` : '') +
    (rt && !rt.ok ? `<div class="alert bad"><b>Cannot place</b>${esc(rt.msg)}</div>` : '') +
    `<div class="btnrow">
       <button id="qPlace" class="primary" ${rt && rt.ok ? '' : 'disabled'}>${cn.placed ? 'Update line' : 'Place line'}</button>
       <button id="qDrop" class="warn">Disconnect</button></div>` +
    (cn.placed ? '' : `<div class="note">Not placed yet — the dashed guide shows the face pair.</div>`) +
    `<div class="btnrow"><button id="qEditSpec" class="ghost mini">Edit “${esc(sp.name)}” on the left</button></div>`;

  const lvlEl = document.getElementById('qLvl');
  lvlEl.addEventListener('input', () => {
    const v = Math.max(0, Math.round(Number(lvlEl.value)||0));
    cn.level = v;
    renderSel(); renderConnections(); draw();
  });
  for (const [id, key] of [['qCols','cols'], ['qRows','rows']]){
    const el = document.getElementById(id);
    el.addEventListener('input', () => {
      cn[key] = Math.max(1, Math.round(Number(el.value)||1));
      renderSel(); renderConnections(); draw();
    });
  }
  document.getElementById('qSpec').onchange = e => {
    cn.specId = e.target.value;
    state.editSpec = cn.specId;
    renderSpecs(); renderSpecEdit(); renderSel(); renderConnections(); draw();
  };
  document.getElementById('qPlace').onclick = () => {
    cn.placed = true; renderSel(); renderConnections(); draw();
  };
  document.getElementById('qDrop').onclick = () => disconnect(cn.uid);
  document.getElementById('qEditSpec').onclick = () => {
    state.editSpec = cn.specId; renderSpecs(); renderSpecEdit();
    document.getElementById('left').scrollTop = 9999;
  };
  wireClusters(box, renderSel);
}

/** Cross-section of one chamber face: the shared conduit grid to scale,
    every conduit as a circle in its spec colour, edge-clearance guides,
    and a caption saying whether the face carries it. */
function faceSectionSVG(L, wpx = 232){
  if (!L.groups.length) return '';
  const ec = L.c.edgeClear || 0, W = L.g.width;
  const pad = 12, scale = (wpx - pad*2) / W;
  const rBig = Math.max(...L.groups.map(g => g.rMax));
  let y = rBig; const tops = [];
  L.groups.forEach((gr, gi) => { tops.push(y); y += (gr.rowsMax-1)*L.S; if (gi < L.groups.length-1) y += L.S; });
  const contentH = y + rBig;
  const hpx = contentH*scale + pad*2 + 16;
  const X = mm => pad + (mm + W/2)*scale;
  const Y = mm => pad + mm*scale;
  const el = [];
  el.push(`<rect x="${X(-W/2)}" y="${pad-4}" width="${W*scale}" height="${contentH*scale+8}" fill="none" stroke="${C.inkFaint}" stroke-width="1"/>`);
  if (L.win){
    const x0 = X(L.shift - L.win.w/2), x1 = X(L.shift + L.win.w/2);
    const yb = L.win.h ? Math.min(pad + L.win.h*scale, pad + contentH*scale + 4) : pad + contentH*scale + 4;
    el.push(`<rect x="${x0}" y="${pad-4}" width="${x1-x0}" height="${yb-(pad-4)}" fill="none" stroke="${C.pick}" stroke-width="1" stroke-dasharray="3 3" opacity=".8"/>`);
  } else
  for (const sgn of [-1, 1])
    el.push(`<line x1="${X(sgn*(W/2-ec))}" y1="${pad-4}" x2="${X(sgn*(W/2-ec))}" y2="${pad+contentH*scale+4}" stroke="${C.inkFaint}" stroke-width="1" stroke-dasharray="3 3" opacity=".7"/>`);
  L.groups.forEach((gr, gi) => {
    for (const it of gr.items){
      if (!it.sp) continue;
      const rp = Math.max(2.2, it.sp.radius*scale);
      for (let rI = 0; rI < it.rows; rI++) for (let cI = 0; cI < it.cols; cI++){
        const xo = it.centreOff + (cI-(it.cols-1)/2)*L.S;
        el.push(`<circle cx="${X(xo)}" cy="${Y(tops[gi]+rI*L.S)}" r="${rp}" fill="none" stroke="${it.sp.colour}" stroke-width="1.6"/>`);
      }
    }
  });
  const cap = L.win
    ? `pitch ${fmt(L.S)} · window ${fmt(L.win.w)}${L.win.h ? '×' + fmt(L.win.h) : ''} · grid ${fmt(L.usedW)} ${L.fits ? '✓' : '✗ OVER'}`
    : `pitch ${fmt(L.S)} · edge ≥${fmt(ec)} · grid ${fmt(L.usedW)} / face ${fmt(W)} ${L.fits ? '✓' : '✗ OVER'}`;
  el.push(`<text x="${wpx/2}" y="${hpx-4}" fill="${L.fits ? C.inkFaint : C.bad}" font-family="${C.mono}" font-size="9.5" text-anchor="middle">${cap}</text>`);
  return `<svg width="${wpx}" height="${hpx}" style="display:block;margin:4px 0 2px">${el.join('')}</svg>`;
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

/* ---------- side settings dialog ---------- */

function openFaceDialog(mh, face){ state.faceDialog = {mh, face}; renderFaceDialog(); }
function closeFaceDialog(){ state.faceDialog = null; renderFaceDialog(); }

/** The launched settings for one side: its runs with stacking controls,
    and the to-scale section through the face. */
function renderFaceDialog(){
  const wrap = document.getElementById('faceDlg');
  const fd = state.faceDialog, c = fd && byUid(fd.mh);
  const n = fd && c ? faceRuns(fd.mh, fd.face).length : 0;
  if (!n){ state.faceDialog = null; wrap.hidden = true; wrap.innerHTML = ''; return; }
  const L = faceLayout(fd.mh, fd.face);
  const rows = L.groups.flatMap(gr => gr.items.map(it => {
    const sp = it.sp || {colour:'#888', name:'?'};
    return `<div class="dlgrow">
      <span class="dot" style="background:${sp.colour}"></span>
      <span class="nm">${esc(sp.name)} — ${it.cols} × ${it.rows}</span>
      <em>L${gr.level}</em>
      <button data-fup="${it.cn.uid}" title="raise (smaller level)">▲</button>
      <button data-fdn="${it.cn.uid}" title="lower (bigger level)">▼</button></div>`;
  }));
  wrap.innerHTML = `<div class="dlgcard">
    <div class="dlghead"><b>${esc(c.ref)} · side ${fd.face}${c.sides && c.sides[fd.face] ? ' (' + esc(c.sides[fd.face]) + ')' : ''}</b>
      <span>${n} run${n === 1 ? '' : 's'}${L.fits ? '' : ' — too narrow'}</span>
      <button id="dlgClose" title="Close">×</button></div>
    ${rows.join('')}
    ${faceSectionSVG(L, 268)}
  </div>`;
  wrap.hidden = false;
  wrap.onclick = e => { if (e.target === wrap) closeFaceDialog(); };
  document.getElementById('dlgClose').onclick = closeFaceDialog;
  wrap.querySelectorAll('[data-fup],[data-fdn]').forEach(b => {
    b.onclick = ev => {
      ev.stopPropagation();
      const up = b.hasAttribute('data-fup');
      const cn = state.connections.find(x => x.uid === b.getAttribute(up ? 'data-fup' : 'data-fdn'));
      if (!cn) return;
      cn.level = Math.max(0, (cn.level|0) + (up ? -1 : 1));
      recomputeRoutes();
      renderSel(); renderConnections(); draw(); renderFaceDialog();
    };
  });
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
function arrayLine(cn){
  const ea = entryFor(cn,'a'), eb = entryFor(cn,'b');
  const S = Math.max(ea ? ea.S||0 : 0, eb ? eb.S||0 : 0);
  const c = runCols(cn), r = runRows(cn);
  if (c === 1 && r === 1) return '';
  return `<b>Array</b> ${c} wide × ${r} high at ${fmt(S)} centres<br>`;
}
function entryLine(cn){
  const A = byUid(cn.a.mh), B = byUid(cn.b.mh);
  const ea = entryFor(cn,'a'), eb = entryFor(cn,'b');
  if (!A || !B || !ea || !eb) return '';
  const lvl = cn.level|0;
  const side = o => o === 0 ? 'centre' : (o > 0 ? '+' : '−') + fmt(Math.abs(o));
  let line = `<b>Entry</b> ${side(ea.offset)} at ${esc(A.ref)} · ${side(eb.offset)} at ${esc(B.ref)}`;
  line += `<br><b>Depth</b> Z ${fmt(chamberZ0(A) - lvl*A.zSpace)} at ${esc(A.ref)} · Z ${fmt(chamberZ0(B) - lvl*B.zSpace)} at ${esc(B.ref)}${lvl ? ` (level ${lvl})` : ''}`;
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
  if (state.view3d) return [state.cam.cx, state.cam.cy];
  const r = STAGE.getBoundingClientRect();
  return S2W([r.width/2, r.height/2]);
};

document.getElementById('btnAdd').onclick = () => {
  const p = viewCentre(), base = state.chambers[state.chambers.length-1];
  const c = makeChamber({x:snap(p[0]), y:snap(p[1]),
    intX: base?base.intX:1200, intY: base?base.intY:1200, wall: base?base.wall:150});
  state.chambers.push(c); select('chamber', c.uid);
};
document.getElementById('btnObs').onclick = () => {
  const p = viewCentre();
  const o = makeObstacle({x:snap(p[0]), y:snap(p[1])});
  state.obstacles.push(o); select('obstacle', o.uid);
};
const btnConnect = document.getElementById('btnConnect');
btnConnect.onclick = () => {
  if (state.view3d && state.mode !== 'connect') setView3d(false);
  state.mode = state.mode === 'connect' ? 'select' : 'connect';
  state.pending = null;
  btnConnect.classList.toggle('on', state.mode === 'connect');
  document.getElementById('rmode').textContent =
    state.mode === 'connect' ? 'connect mode — click two internal faces' : '';
  draw();
};
document.getElementById('btnFit').onclick = () => fitView();
document.getElementById('btnView3d').onclick = () => setView3d(!state.view3d);
document.getElementById('snap').oninput = e => { state.snap = Math.max(0, Number(e.target.value)||0); };
document.getElementById('grid').onchange = e => { state.showGrid = e.target.checked; draw(); };
document.getElementById('dims').onchange = e => { state.showDims = e.target.checked; draw(); };
document.getElementById('avoidMH').onchange = e => {
  state.avoidChambers = e.target.checked; renderSel(); renderConnections(); draw();
};
document.getElementById('avoidPipe').onchange = e => {
  state.avoidPipes = e.target.checked; renderSel(); renderConnections(); draw();
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
}

document.getElementById('btnExport').onclick = () => {
  recomputeRoutes();
  const data = {
    units:'mm', axes:'+X east, +Y north',
    ground: state.ground, cover: state.cover,
    specs: state.specs.map(({id, ...rest}) => rest),
    chambers: state.chambers.map(({uid, ...rest}) => rest),
    obstacles: state.obstacles.map(({uid, ...rest}) => rest),
    runs: state.connections.map(cn => {
      const rt = cn.route, sp = specOf(cn);
      const A = byUid(cn.a.mh), B = byUid(cn.b.mh);
      const ea = entryFor(cn,'a'), eb = entryFor(cn,'b');
      return {
        from:{ref: A?.ref, face: cn.a.face, lateralOffset: ea ? Math.round(ea.offset) : 0,
              zOffset: A ? -(cn.level|0)*A.zSpace : 0, z: A ? chamberZ0(A) - (cn.level|0)*A.zSpace : null},
        to:  {ref: B?.ref, face: cn.b.face, lateralOffset: eb ? Math.round(eb.offset) : 0,
              zOffset: B ? -(cn.level|0)*B.zSpace : 0, z: B ? chamberZ0(B) - (cn.level|0)*B.zSpace : null},
        spec: sp ? sp.name : null,
        level: cn.level|0,
        rows: runRows(cn), cols: runCols(cn),
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
      syncDrawingInputs();
      state.chambers  = (d.chambers ||[]).map(c => makeChamber({buffer:0, ...c, uid:uid()}));
      state.obstacles = (d.obstacles||[]).map(o => {
        const m = makeObstacle({...o, buffer: o.buffer != null ? o.buffer : (o.clearance != null ? o.clearance : 250), uid:uid()});
        delete m.clearance; return m;
      });
      const byRef  = r => state.chambers.find(c => c.ref === r);
      const byName = n => state.specs.find(s => s.name === n) || state.specs[0];
      state.connections = (d.runs || d.connections || []).map(cn => {
        const A = byRef(cn.from?.ref), B = byRef(cn.to?.ref);
        if (!A || !B) return null;
        return {uid:uid(), a:{mh:A.uid, face:legacyFace(cn.from.face)}, b:{mh:B.uid, face:legacyFace(cn.to.face)},
                placed: !!cn.placed, level: Math.max(0, cn.level|0),
                rows: Math.max(1, cn.rows|0 || 1), cols: Math.max(1, cn.cols|0 || 1),
                specId: byName(cn.spec).id, route:null};
      }).filter(Boolean);
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
      const mirrored = (bx[0]*by[1] - bx[1]*by[0]) < 0;     // handedness flipped: family +Y is local -Y
      const flipW = w => w ? {...w, off:-w.off} : w;
      const sides = mirrored ? {A:sidesBase.C, C:sidesBase.A, B:sidesBase.B, D:sidesBase.D} : {...sidesBase};
      const win = mirrored ? {A:winBase.C, C:winBase.A, B:flipW(winBase.B), D:flipW(winBase.D)} : {...winBase};
      const lid = lidX && lidY ? {x:lidX, y: mirrored ? [-lidY[1], -lidY[0]] : lidY} : null;
      made.push(makeChamber({
        ref: inst.mark || null,
        x: Math.round(wx), y: Math.round(wy), rot: Math.round(rot*100)/100,
        intX: Math.round(intX), intY: Math.round(intY), wall,
        z0: Math.round(o[2] + (wZ ? wZ.hi - 150 : -600)),       // top row a half pitch below the window top
        zLid: Math.round(o[2] + (zs.length ? Math.max(...zs) : 0)),
        zBase: Math.round(o[2] + (zs.length ? Math.min(...zs) : -1800)),
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
    const flag = k => ob[k] == null ? true : !!ob[k];
    obstacles.push(makeObstacle({
      name: ob.mark || ob.name || null,
      x: Math.round(o[0] + bx[0]*cx + by[0]*cy), y: Math.round(o[1] + bx[1]*cx + by[1]*cy),
      rot: Math.round((ob.rotation_deg != null ? ob.rotation_deg : Math.atan2(bx[1], bx[0])*R2D)*100)/100,
      w: Math.round(mx[0]-mn[0]), d: Math.round(mx[1]-mn[1]),
      zTop: Math.round(o[2] + mx[2]), zBot: Math.round(o[2] + mn[2]),
      around: flag('around'), over: flag('over'), under: flag('under'),
      src: 'revit', family: ob.family || null, type: ob.type || null
    }));
  }
  return {chambers: made, obstacles};
}

document.getElementById('revitIn').onchange = e => {
  const f = e.target.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const {chambers: made, obstacles: obs} = importRevit(JSON.parse(rd.result));
      if (!made.length && !obs.length) throw new Error('no manhole family (a1/a7 and b1/b7 planes) and no flagged obstacles found');
      const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
      const replace = (!state.chambers.length && !state.obstacles.length) ||
        confirm(`Import ${n(made.length, 'manhole')} and ${n(obs.length, 'obstacle')} from Revit — replace the current drawing? (Cancel adds them alongside.)`);
      if (replace){ state.chambers = []; state.obstacles = []; state.connections = []; }
      for (const c of made){
        if (!c.ref || state.chambers.some(x => x.ref === c.ref)) c.ref = nextRef();
        state.chambers.push(c);
      }
      for (const o of obs){
        if (!o.name || state.obstacles.some(x => x.name === o.name)) o.name = nextName();
        state.obstacles.push(o);
      }
      state.sel = null; state.pending = null;
      renderSel(); renderConnections(); renderObstacles(); fitView();
    } catch(err){ alert('That file is not a Revit manhole export: ' + err.message); }
    e.target.value = '';
  };
  rd.readAsText(f);
};

document.getElementById('btnClear').onclick = () => {
  if (!state.chambers.length || confirm('Remove every chamber, obstacle and conduit run?')){
    state.chambers = []; state.obstacles = []; state.connections = [];
    state.sel = null; state.pending = null;
    renderSel(); renderConnections(); renderObstacles(); draw();
  }
};

document.addEventListener('keydown', e => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
  if (state.faceDialog){ if (e.key === 'Escape') closeFaceDialog(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace'){
    if (selIs('conn')){ e.preventDefault(); disconnect(state.sel.id); }
    else if (selIs('chamber')){ e.preventDefault(); removeChamber(state.sel.id); }
    else if (selIs('obstacle')){
      e.preventDefault();
      state.obstacles = state.obstacles.filter(o => o.uid !== state.sel.id);
      state.sel = null; renderSel(); renderObstacles(); renderConnections(); draw();
    }
  } else if (e.key === 'Escape'){ state.pending = null; select(null); }
  else if (e.key === 'f' || e.key === 'F'){ fitView(); }
  else if (e.key === '3'){ setView3d(!state.view3d); }
  else if (e.key.startsWith('Arrow') && (selIs('chamber') || selIs('obstacle'))){
    e.preventDefault();
    const o = selIs('chamber') ? byUid(state.sel.id) : obsBy(state.sel.id);
    const d = (state.snap || 10) * (e.shiftKey ? 10 : 1);
    if (e.key === 'ArrowLeft')  o.x -= d;
    if (e.key === 'ArrowRight') o.x += d;
    if (e.key === 'ArrowUp')    o.y += d;
    if (e.key === 'ArrowDown')  o.y -= d;
    renderSel(); renderConnections(); draw();
  }
});

new ResizeObserver(() => draw()).observe(STAGE);

/* ==========================================================================
   START
   ========================================================================== */

state.specs = [
  makeSpec({name:'MV',        colour:'#e0655f', radius:100, bendR:1800, stub:600, minLeg:600, buffer:600, spacing:600, warnAngle:45, angles:[11.25,22.5,45]}),
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
