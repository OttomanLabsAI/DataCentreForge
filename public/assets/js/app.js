/* ==========================================================================
   MANHOLE PLAN
   Square chambers with wall thickness, rectangular obstacles, and pipe runs
   routed internal face to internal face under a named pipe spec: bore, bend
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
  showGrid: true, showDims: true, avoidChambers: true, square: true
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
  return Object.assign({uid:uid(), ref:nextRef(), x:0, y:0, intX:1200, intY:1200, wall:150, rot:0}, o);
}
function makeObstacle(o = {}){
  return Object.assign({uid:uid(), name:nextName(), x:0, y:0, w:2400, d:2400, rot:0, clearance:250}, o);
}
function makeSpec(o = {}){
  return Object.assign({
    id:uid(), name:'New spec', colour:SPEC_COLOURS[state.specs.length % SPEC_COLOURS.length],
    radius:150, bendR:600, stub:500, minLeg:500, warnAngle:45, angles:[22.5,45,90]
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

const FACES = ['N','E','S','W'];
const D2R = Math.PI/180, R2D = 180/Math.PI;
const norm = v => { const L = Math.hypot(v[0],v[1]) || 1; return [v[0]/L, v[1]/L]; };
const rotv = (v,d) => { const r = d*D2R, c = Math.cos(r), s = Math.sin(r);
                        return [v[0]*c - v[1]*s, v[0]*s + v[1]*c]; };
const wrap = a => { a = ((a+180)%360 + 360)%360 - 180; return a === -180 ? 180 : a; };
const signedAngle = (a,b) => wrap(Math.atan2(a[0]*b[1]-a[1]*b[0], a[0]*b[0]+a[1]*b[1]) * R2D);

function localFace(c, f){
  const a = c.intX/2, b = c.intY/2;
  return {N:{p1:[-a,b], p2:[a,b], n:[0,1]},  E:{p1:[a,b], p2:[a,-b], n:[1,0]},
          S:{p1:[a,-b], p2:[-a,-b], n:[0,-1]}, W:{p1:[-a,-b], p2:[-a,b], n:[-1,0]}}[f];
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
function distToSeg(p, a, b){
  const vx = b[0]-a[0], vy = b[1]-a[1], wx = p[0]-a[0], wy = p[1]-a[1];
  const L2 = vx*vx + vy*vy;
  const t = L2 ? Math.max(0, Math.min(1, (wx*vx + wy*vy)/L2)) : 0;
  return Math.hypot(p[0]-(a[0]+t*vx), p[1]-(a[1]+t*vy));
}

/* ==========================================================================
   PIPE ROUTING
   Leaves the internal face along its outward normal, arrives at the far
   internal face along the inward normal, changes direction only by an angle
   the spec permits, keeps every straight at or above the minimum, and stays
   clear of every blocker by the pipe radius plus the obstacle's clearance.
   ========================================================================== */

const SAMPLES = 10, SEQ_CAP = 300, BUDGET = 30000;
/* Route cost, in millimetres of pipe: every bend is worth this much extra
   length, and a bend that trips a warning far more — so the router only
   reaches for a big or over-limit bend when it saves serious pipe. */
const BEND_COST = 1500, ANGLE_COST = 4000, RADIUS_COST = 3000;
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
  for (let i = 0; i < poly.length-1; i++)
    for (const B of blockers) if (hitsBlocker(poly[i], poly[i+1], B)) return false;
  return true;
}

/** Minimum length of each straight as routed: ends are measured off the
    chamber face, interiors between bends. Strict mode adds the bend tangents
    on top, so the full radius fits without eating into the straight. */
function segMins(turns, spec, strict){
  const n = turns.length + 1;
  const T = turns.map(t => spec.bendR * Math.tan(Math.abs(t)*D2R/2));
  const lo = [];
  for (let i = 0; i < n; i++){
    const base = Math.max(1, (i === 0 || i === n-1) ? spec.stub : spec.minLeg);
    lo.push(strict ? base + (i > 0 ? T[i-1] : 0) + (i < n-1 ? T[i] : 0) : base);
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
/** Feasible sets of straight lengths for one turn sequence. */
function candidates(P, d0, V, turns, lo, fine){
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
    if (Math.abs(cr) <= 1 && dot >= lo[0]) res.push(build([dot]));
    return res;
  }
  if (n === 2){ push(solveWith(ds, V, 0, 1, [0,0])); return res; }

  const pairs = n === 3 ? [[1,2],[0,2],[0,1]] : n === 4 ? [[1,2],[0,3],[0,2]] : [[1,3],[2,3],[1,2]];
  for (const [ia,ib] of pairs){
    const free = []; for (let i = 0; i < n; i++) if (i !== ia && i !== ib) free.push(i);
    const fixed = lo.slice();
    if (free.length === 1){
      for (let k = 0; k <= NS; k++){
        fixed[free[0]] = lo[free[0]] + span*k/NS;
        push(solveWith(ds, V, ia, ib, fixed));
      }
    } else {
      for (let k = 0; k <= GS; k++) for (let m = 0; m <= GS; m++){
        fixed[free[0]] = lo[free[0]] + span*k/GS; fixed[free[1]] = lo[free[1]] + span*m/GS;
        push(solveWith(ds, V, ia, ib, fixed));
      }
    }
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
  const scoreOf = f => f.length + BEND_COST*f.turns.length
    + ANGLE_COST*f.warnings.filter(w => w.kind === 'angle').length
    + RADIUS_COST*f.warnings.filter(w => w.kind === 'radius').length;
  const evalCands = (seq, fine) => {
    for (const sol of candidates(P, d0, V, seq, segMins(seq, spec, strict), fine)){
      if (--budget < 0) return;
      sawSolution = true;
      const f = applyFillets(sol, spec);
      f.poly = tessellate(f);
      if (!clearOf(f.poly, blockers)){ sawBlocked = true; continue; }
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

  const strict = search(P, d0, V, delta, signed, spec, blockers, true);
  if (strict.ok) return strict;
  const relaxed = search(P, d0, V, delta, signed, spec, blockers, false);
  if (relaxed.ok) return relaxed;
  return {ok:false, msg: relaxed.sawBlocked ? 'blocked — no way past the obstacles'
    : relaxed.sawSolution ? 'no room — shorten the minimum straights'
    : angles.length ? 'no route to that face with these angles' : 'allow a bend angle'};
}

function blockersFor(cn){
  const sp = specOf(cn), out = [];
  for (const o of state.obstacles)
    out.push({cx:o.x, cy:o.y, rot:o.rot, hw:o.w/2, hh:o.d/2, margin: sp.radius + o.clearance});
  if (state.avoidChambers)
    for (const c of state.chambers){
      if (c.uid === cn.a.mh || c.uid === cn.b.mh) continue;
      out.push({cx:c.x, cy:c.y, rot:c.rot, hw:c.intX/2+c.wall, hh:c.intY/2+c.wall, margin: sp.radius});
    }
  return out;
}
function routeOf(cn){
  const A = byUid(cn.a.mh), B = byUid(cn.b.mh);
  if (!A || !B) return {ok:false, msg:'missing chamber'};
  const sp = specOf(cn);
  if (!sp) return {ok:false, msg:'no pipe spec'};
  const ga = faceGeom(A, cn.a.face), gb = faceGeom(B, cn.b.face);
  return solveRoute(ga.mid, ga.n, gb.mid, [-gb.n[0], -gb.n[1]], sp, blockersFor(cn));
}
/** Routes are only re-solved when something they depend on actually moved. */
function routeSignature(cn){
  const A = byUid(cn.a.mh), B = byUid(cn.b.mh);
  const box = o => [o.x, o.y, o.w, o.d, o.rot, o.clearance];
  const mh  = c => [c.x, c.y, c.intX, c.intY, c.wall, c.rot];
  return JSON.stringify([cn.a.face, cn.b.face, A && mh(A), B && mh(B), specOf(cn),
    state.avoidChambers, ROUTE_QUICK, state.obstacles.map(box), state.chambers.map(mh)]);
}
function recomputeRoutes(){
  for (const cn of state.connections){
    const sig = routeSignature(cn);
    if (cn._sig === sig && cn.route) continue;
    cn._sig = sig; cn.route = routeOf(cn);
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

function gridStep(){
  const steps = [50,100,250,500,1000,2500,5000,10000,25000,50000,100000];
  for (const st of steps) if (st*state.view.s >= 55) return st;
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
  const s = state.view.s, body = boxCorners(o, 0), clr = boxCorners(o, o.clearance);
  const stroke = on ? C.sel : C.obsLine;
  const out = [];
  if (o.clearance > 0)
    out.push(`<polygon points="${pts(clr)}" fill="none" stroke="${C.obsHatch}" stroke-width="1" stroke-dasharray="5 4" opacity=".85"/>`);
  out.push(`<polygon points="${pts(body)}" fill="${C.obsFill}"/>`);
  out.push(`<polygon points="${pts(body)}" fill="url(#obs)" opacity=".8"/>`);
  out.push(`<polygon points="${pts(body)}" fill="none" stroke="${stroke}" stroke-width="${on?2:1.3}"/>`);
  if (Math.min(o.w,o.d)*s > 44){
    const ctr = W2S([o.x, o.y]);
    out.push(`<text x="${ctr[0]}" y="${ctr[1]+4}" fill="${stroke}" font-family="${C.mono}" font-size="11" text-anchor="middle">${esc(o.name)}</text>`);
  }
  return out.join('');
}

function drawConnection(cn){
  const A = byUid(cn.a.mh), B = byUid(cn.b.mh);
  if (!A || !B) return '';
  const s = state.view.s, sp = specOf(cn), rt = cn.route;
  const on = selIs('conn') && state.sel.id === cn.uid;
  const ga = faceGeom(A, cn.a.face), gb = faceGeom(B, cn.b.face);
  const p = W2S(ga.mid), q = W2S(gb.mid);
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

  const d = routePathScreen(rt), body = Math.max(1.5, 2*sp.radius*s);
  const edge = on ? C.sel : sp.colour;
  out.push(`<path d="${d}" fill="none" stroke="${edge}" stroke-width="${body}" stroke-linejoin="round" stroke-linecap="butt" opacity=".95"/>`);
  if (body > 4) out.push(`<path d="${d}" fill="none" stroke="${C.pipeBody}" stroke-width="${body-2.4}" stroke-linejoin="round" stroke-linecap="butt"/>`);
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
    const m = W2S(rt.pts[Math.floor(rt.pts.length/2)]);
    out.push(`<text x="${m[0]}" y="${m[1]-body/2-7}" fill="${edge}" font-family="${C.mono}" font-size="10.5" text-anchor="middle">${metres(rt.length)}</text>`);
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
function drawScaleBar(){
  const el = document.getElementById('scalebar');
  const opts = [100,200,500,1000,2000,5000,10000,20000,50000,100000];
  let pick = opts[0];
  for (const o of opts){ pick = o; if (o*state.view.s >= 70) break; }
  el.querySelector('.bar').style.width = (pick*state.view.s) + 'px';
  el.querySelector('span').textContent = pick >= 1000 ? (pick/1000)+' m' : pick+' mm';
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
      const A = byUid(cn.a.mh), B = byUid(cn.b.mh);
      if (!A || !B) continue;
      line = [faceGeom(A, cn.a.face).mid, faceGeom(B, cn.b.face).mid];
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
  STAGE.setPointerCapture(e.pointerId);
  const r = STAGE.getBoundingClientRect();
  const sp = [e.clientX-r.left, e.clientY-r.top], wp = S2W(sp);

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

STAGE.addEventListener('pointerup', () => {
  drag = null;
  if (ROUTE_QUICK){ ROUTE_QUICK = false; renderSel(); renderConnections(); draw(); }
});
STAGE.addEventListener('pointerleave', () => {
  state.hoverFace = null; showCallout(null); draw();
  document.getElementById('rx').textContent = '—';
  document.getElementById('ry').textContent = '—';
});
STAGE.addEventListener('contextmenu', e => e.preventDefault());
STAGE.addEventListener('wheel', e => {
  e.preventDefault();
  const r = STAGE.getBoundingClientRect();
  const sp = [e.clientX-r.left, e.clientY-r.top], before = S2W(sp);
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
  el.innerHTML = `<u>${esc(c.ref)} · ${f.face} face</u>\n`
    + `internal face   ${fmt(g.width)} wide\n`
    + `mid  X ${fmt(g.mid[0])}  Y ${fmt(g.mid[1])}\n`
    + `outward bearing ${g.bearing.toFixed(1)}°`;
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
  const cn = {uid:uid(), a:state.pending, b:f, placed:false,
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
               : (warn ? '⚠ ' : '') + metres(rt.length);
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
    box.innerHTML = `<div class="empty">None. Add one with <b>+ Obstacle</b> — pipe runs are routed around it, keeping its clearance.</div>`;
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
   PIPE SPECS  (left panel)
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
    numRow('sRad','Pipe radius', sp.radius, 25, 'mm') +
    numRow('sBend','Bend radius', sp.bendR, 50, 'mm') +
    `<div class="row" style="margin-bottom:2px"><label>Minimum straight</label></div>` +
    numRow('sStub','off chamber face', sp.stub, 50, 'mm') +
    numRow('sLeg','between bends', sp.minLeg, 50, 'mm') +
    numRow('sWarn','Warn above', sp.warnAngle, 5, '°') +
    `<div class="row" style="margin-top:4px"><label>Bend angles allowed</label></div>
     <div class="chips" id="sAngles">${ANGLE_OPTIONS.map(a =>
        `<button class="chip ${sp.angles.includes(a)?'on':''}" data-ang="${a}">${a}°</button>`).join('')}</div>
     <div class="derived"><b>Bore</b> ${fmt(sp.radius*2)} mm · <b>bend</b> R${fmt(sp.bendR)}<br>
       <b>Straights</b> ≥${fmt(sp.stub)} off face · ≥${fmt(sp.minLeg)} between bends<br>
       <b>Fittings</b> ${sp.angles.length ? sp.angles.map(a => fmt1(a)+'°').join(' · ') : 'straight only'}</div>`;

  const bindS = (id, key, cast = Number) => {
    const el = document.getElementById(id);
    el.addEventListener('input', () => {
      const v = cast(el.value);
      if (cast === Number && (!Number.isFinite(v) || v < 0)) return;
      sp[key] = v; specChanged();
    });
  };
  bindS('sName','name',String); bindS('sRad','radius'); bindS('sBend','bendR');
  bindS('sStub','stub'); bindS('sLeg','minLeg'); bindS('sWarn','warnAngle');
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

function renderSel(){
  recomputeRoutes();
  const box = document.getElementById('sel'), ttl = document.getElementById('selTitle');
  if (selIs('chamber')) { ttl.textContent = 'Chamber';  return renderChamberProps(box, byUid(state.sel.id)); }
  if (selIs('obstacle')){ ttl.textContent = 'Obstacle'; return renderObstacleProps(box, obsBy(state.sel.id)); }
  if (selIs('conn'))    { ttl.textContent = 'Pipe run'; return renderRunProps(box, connBy(state.sel.id)); }
  ttl.textContent = 'Selection';
  box.innerHTML = `<div class="empty">Nothing selected. Click a chamber, an obstacle or a pipe run.</div>`;
}

function renderChamberProps(box, c){
  if (!c){ box.innerHTML = ''; return; }
  box.innerHTML =
    `<div class="row"><label for="pRef">Reference</label><input type="text" id="pRef" value="${esc(c.ref)}"></div>` +
    numRow('pIX','Internal L (X)', c.intX, 25, 'mm') +
    numRow('pIY','Internal W (Y)', c.intY, 25, 'mm') +
    `<div class="row"><label class="chk"><input type="checkbox" id="pSq" ${state.square?'checked':''}> Keep square</label></div>` +
    numRow('pW','Wall thickness', c.wall, 25, 'mm') +
    numRow('pX','Centre X', c.x, state.snap||1, 'mm') +
    numRow('pY','Centre Y', c.y, state.snap||1, 'mm') +
    numRow('pR','Rotation', c.rot, 15, '°') +
    `<div class="derived">
       <b>External</b> ${fmt(c.intX+2*c.wall)} × ${fmt(c.intY+2*c.wall)} mm<br>
       <b>Internal plan area</b> ${(c.intX*c.intY/1e6).toFixed(2)} m²<br>
       <b>Faces</b> ${FACES.map(f => f+' '+fmt(faceGeom(c,f).width)).join('  ')}</div>
     <div class="btnrow"><button id="pDup">Duplicate</button><button id="pDel" class="warn">Delete</button></div>`;
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
  bind('pW','wall'); bind('pX','x'); bind('pY','y'); bind('pR','rot');
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
    numRow('oW','Width (X)', o.w, 100, 'mm') +
    numRow('oD','Depth (Y)', o.d, 100, 'mm') +
    numRow('oX','Centre X', o.x, state.snap||1, 'mm') +
    numRow('oY','Centre Y', o.y, state.snap||1, 'mm') +
    numRow('oR','Rotation', o.rot, 15, '°') +
    numRow('oC','Clearance', o.clearance, 50, 'mm') +
    `<div class="derived"><b>Keep-out</b> ${fmt(o.w+2*o.clearance)} × ${fmt(o.d+2*o.clearance)} mm<br>
       <span>Pipes are held off by this clearance plus their own radius.</span></div>
     <div class="btnrow"><button id="oDup">Duplicate</button><button id="oDel" class="warn">Delete</button></div>`;
  const bind = (id, key, cast = Number) => {
    const el = document.getElementById(id);
    el.addEventListener('input', () => {
      const v = cast(el.value);
      if (cast === Number && !Number.isFinite(v)) return;
      o[key] = v; renderObstacles(); renderConnections(); draw();
    });
  };
  bind('oName','name',String); bind('oW','w'); bind('oD','d');
  bind('oX','x'); bind('oY','y'); bind('oR','rot'); bind('oC','clearance');
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
    `<div class="row"><label style="flex:none" for="qSpec">Pipe spec</label></div>
     <select id="qSpec">${state.specs.map(s =>
       `<option value="${s.id}" ${s.id === cn.specId ? 'selected':''}>${esc(s.name)} — Ø${fmt(s.radius*2)} R${fmt(s.bendR)}</option>`).join('')}</select>
     <div class="derived">
       <b>Run</b> ${esc(connLabel(cn))}<br>
       <b>Angles</b> ${sp.angles.length ? sp.angles.map(a => fmt1(a)+'°').join(' · ') : 'straight only'}<br>` +
       (rt && rt.ok
         ? `<b>Bends</b> ${rt.turns.length ? rt.turns.map(t => fmt1(Math.abs(t))+'°').join(' · ') : 'none — straight run'}<br>
            <b>Straight pipe</b> ${rt.clear.map(v => fmt(Math.max(0,v))).join(' · ')} mm<br>
            <b>Centreline</b> ${metres(rt.length)} face to face`
         : `<span style="color:${C.bad}">${esc(rt ? rt.msg : '')}</span>`) +
    `</div>` +
    (warns.length ? `<div class="alert warn"><b>Check these bends</b>${warns.map(w => esc(w.text)).join('<br>')}</div>` : '') +
    (rt && !rt.ok ? `<div class="alert bad"><b>Cannot place</b>${esc(rt.msg)}</div>` : '') +
    `<div class="btnrow">
       <button id="qPlace" class="primary" ${rt && rt.ok ? '' : 'disabled'}>${cn.placed ? 'Update line' : 'Place line'}</button>
       <button id="qDrop" class="warn">Disconnect</button></div>` +
    (cn.placed ? '' : `<div class="note">Not placed yet — the dashed guide shows the face pair.</div>`) +
    `<div class="btnrow"><button id="qEditSpec" class="ghost mini">Edit “${esc(sp.name)}” on the left</button></div>`;

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
  state.mode = state.mode === 'connect' ? 'select' : 'connect';
  state.pending = null;
  btnConnect.classList.toggle('on', state.mode === 'connect');
  document.getElementById('rmode').textContent =
    state.mode === 'connect' ? 'connect mode — click two internal faces' : '';
  draw();
};
document.getElementById('btnFit').onclick = () => fitView();
document.getElementById('snap').oninput = e => { state.snap = Math.max(0, Number(e.target.value)||0); };
document.getElementById('grid').onchange = e => { state.showGrid = e.target.checked; draw(); };
document.getElementById('dims').onchange = e => { state.showDims = e.target.checked; draw(); };
document.getElementById('avoidMH').onchange = e => {
  state.avoidChambers = e.target.checked; renderSel(); renderConnections(); draw();
};

document.getElementById('btnExport').onclick = () => {
  recomputeRoutes();
  const data = {
    units:'mm', axes:'+X east, +Y north',
    specs: state.specs.map(({id, ...rest}) => rest),
    chambers: state.chambers.map(({uid, ...rest}) => rest),
    obstacles: state.obstacles.map(({uid, ...rest}) => rest),
    runs: state.connections.map(cn => {
      const rt = cn.route, sp = specOf(cn);
      return {
        from:{ref: byUid(cn.a.mh)?.ref, face: cn.a.face},
        to:  {ref: byUid(cn.b.mh)?.ref, face: cn.b.face},
        spec: sp ? sp.name : null,
        placed: cn.placed,
        route: rt && rt.ok ? {
          vertices: rt.pts.map(p => [Math.round(p[0]), Math.round(p[1])]),
          bends: rt.turns.map((t,i) => ({deflection:t, radius: Math.round(rt.fillets[i].R)})),
          straights: rt.segs.map(v => Math.round(v)),
          straightPipe: rt.clear.map(v => Math.round(Math.max(0,v))),
          centrelineLength: Math.round(rt.length),
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
      state.chambers  = (d.chambers ||[]).map(c => makeChamber({...c, uid:uid()}));
      state.obstacles = (d.obstacles||[]).map(o => makeObstacle({...o, uid:uid()}));
      const byRef  = r => state.chambers.find(c => c.ref === r);
      const byName = n => state.specs.find(s => s.name === n) || state.specs[0];
      state.connections = (d.runs || d.connections || []).map(cn => {
        const A = byRef(cn.from?.ref), B = byRef(cn.to?.ref);
        if (!A || !B) return null;
        return {uid:uid(), a:{mh:A.uid, face:cn.from.face}, b:{mh:B.uid, face:cn.to.face},
                placed: !!cn.placed, specId: byName(cn.spec).id, route:null};
      }).filter(Boolean);
      state.sel = null; state.editSpec = state.specs[0].id;
      renderSpecs(); renderSpecEdit(); renderSel(); renderConnections(); renderObstacles(); fitView();
    } catch(err){ alert('That file is not a plan export. Expected JSON with a chambers array.'); }
    e.target.value = '';
  };
  rd.readAsText(f);
};

document.getElementById('btnClear').onclick = () => {
  if (!state.chambers.length || confirm('Remove every chamber, obstacle and pipe run?')){
    state.chambers = []; state.obstacles = []; state.connections = [];
    state.sel = null; state.pending = null;
    renderSel(); renderConnections(); renderObstacles(); draw();
  }
};

document.addEventListener('keydown', e => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
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
  makeSpec({name:'DN300 storm',  colour:SPEC_COLOURS[0], radius:150,   bendR:600, stub:500, minLeg:750, warnAngle:45, angles:[22.5,45,90]}),
  makeSpec({name:'DN225 foul',   colour:SPEC_COLOURS[1], radius:112.5, bendR:450, stub:400, minLeg:600, warnAngle:45, angles:[11.25,22.5,45,90]}),
  makeSpec({name:'DN150 branch', colour:SPEC_COLOURS[2], radius:75,    bendR:300, stub:300, minLeg:450, warnAngle:90, angles:[45,90]})
];
state.editSpec = state.specs[0].id;

state.chambers = [
  makeChamber({ref:'MH01', x:0,     y:0,    intX:1200, intY:1200, wall:150}),
  makeChamber({ref:'MH02', x:12000, y:0,    intX:1500, intY:1500, wall:200}),
  makeChamber({ref:'MH03', x:22000, y:4500, intX:1200, intY:1200, wall:150, rot:45})
];
state.obstacles = [ makeObstacle({name:'OBS01', x:6000, y:0, w:2400, d:3600, rot:0, clearance:250}) ];
state.connections = [
  {uid:uid(), a:{mh:state.chambers[0].uid, face:'E'}, b:{mh:state.chambers[1].uid, face:'W'},
   placed:true,  specId:state.specs[0].id, route:null},
  {uid:uid(), a:{mh:state.chambers[1].uid, face:'E'}, b:{mh:state.chambers[2].uid, face:'W'},
   placed:false, specId:state.specs[1].id, route:null}
];

renderSpecs(); renderSpecEdit(); renderSel(); renderConnections(); renderObstacles(); fitView();
