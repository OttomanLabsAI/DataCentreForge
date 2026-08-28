/* ==========================================================================
   MANHOLE PLAN
   Square chambers drawn as internal box + wall thickness, joined by pipe runs
   routed internal face to internal face under a set of permitted bend angles.
   Units: millimetres. World axes: +X east, +Y north.
   ========================================================================== */

const SVG   = document.getElementById('svg');
const STAGE = document.getElementById('stage');

const C = {
  ink:'#dfe6ef', inkDim:'#8894a4', inkFaint:'#5b6675',
  wall:'#59657a', chamber:'#161d27',
  sel:'#ffb454', pick:'#35c3e8', bad:'#e0655f',
  pipeEdge:'#35c3e8', pipeBody:'#12242c', pipeGhost:'#4c5a6b',
  gridMinor:'#1a212b', gridMajor:'#27313f', axisX:'#5c3436', axisY:'#2f5c40',
  mono:'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
};

const ANGLE_OPTIONS = [11.25, 15, 22.5, 30, 45, 60, 90];

const state = {
  chambers: [],
  connections: [],
  view: {tx:0, ty:0, s:0.04},
  sel: null,            // selected chamber uid
  selConn: null,        // selected connection uid
  hoverFace: null,
  mode: 'select',       // 'select' | 'connect'
  pending: null,
  snap: 50,
  showGrid: true,
  showDims: true,
  square: true,
  pipeDefaults: {radius:150, bendR:600, stub:500, angles:[22.5, 45, 90]}
};

let uidSeq = 1;
const uid = () => 'e' + (uidSeq++);
const byUid  = u => state.chambers.find(c => c.uid === u);
const connBy = u => state.connections.find(c => c.uid === u);

/* ---------- chambers ------------------------------------------------------ */

function makeChamber(o = {}){
  return Object.assign({
    uid: uid(), ref: nextRef(),
    x:0, y:0, intX:1200, intY:1200, wall:150, rot:0
  }, o);
}
function nextRef(){
  let n = 1;
  const used = new Set(state.chambers.map(c => c.ref));
  while (used.has('MH' + String(n).padStart(2,'0'))) n++;
  return 'MH' + String(n).padStart(2,'0');
}

/* ==========================================================================
   GEOMETRY
   Faces are named in the chamber's LOCAL frame: N=+Y, E=+X, S=-Y, W=-X.
   faceGeom() returns the INTERNAL face — the inside surface of that wall.
   ========================================================================== */

const FACES = ['N','E','S','W'];
const D2R = Math.PI/180, R2D = 180/Math.PI;
const norm = v => { const L = Math.hypot(v[0],v[1]) || 1; return [v[0]/L, v[1]/L]; };
const rotv = (v,deg) => { const r = deg*D2R, c = Math.cos(r), s = Math.sin(r);
                          return [v[0]*c - v[1]*s, v[0]*s + v[1]*c]; };
const wrap = a => { a = ((a+180)%360 + 360)%360 - 180; return a === -180 ? 180 : a; };
const signedAngle = (a,b) => wrap(Math.atan2(a[0]*b[1]-a[1]*b[0], a[0]*b[0]+a[1]*b[1]) * R2D);

function localFace(c, f){
  const a = c.intX/2, b = c.intY/2;
  return {
    N:{p1:[-a, b], p2:[ a, b], n:[0, 1]},
    E:{p1:[ a, b], p2:[ a,-b], n:[1, 0]},
    S:{p1:[ a,-b], p2:[-a,-b], n:[0,-1]},
    W:{p1:[-a,-b], p2:[-a, b], n:[-1,0]}
  }[f];
}
function toWorld(c, p){
  const r = c.rot*D2R, co = Math.cos(r), si = Math.sin(r);
  return [c.x + p[0]*co - p[1]*si, c.y + p[0]*si + p[1]*co];
}

/** Internal face of chamber c on side f, in world mm. */
function faceGeom(c, f){
  const lf = localFace(c, f);
  const p1 = toWorld(c, lf.p1), p2 = toWorld(c, lf.p2);
  const n  = rotv(lf.n, c.rot);
  const mid = [(p1[0]+p2[0])/2, (p1[1]+p2[1])/2];
  return {
    mh:c.uid, ref:c.ref, face:f, p1, p2, mid, n,
    width: Math.hypot(p2[0]-p1[0], p2[1]-p1[1]),
    outerMid: [mid[0] + n[0]*c.wall, mid[1] + n[1]*c.wall],
    bearing: (450 - Math.atan2(n[1], n[0])*R2D) % 360
  };
}
function corners(c, inset){
  const a = c.intX/2 + inset, b = c.intY/2 + inset;
  return [[-a,-b],[a,-b],[a,b],[-a,b]].map(p => toWorld(c, p));
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
   Leaves the internal face of A along its outward normal, arrives at the
   internal face of B along the inward normal. Every change of direction must
   be one of the permitted angles; every straight must be at least `stub`.
   Bends are then filleted at `bendR`, reduced per bend if there isn't room.
   ========================================================================== */

function solve2(u, v, r){
  const det = u[0]*v[1] - u[1]*v[0];
  if (Math.abs(det) < 1e-9) return null;
  return [(r[0]*v[1] - r[1]*v[0])/det, (u[0]*r[1] - u[1]*r[0])/det];
}
function dirsFrom(d0, turns){
  const ds = [d0]; let cur = d0;
  for (const t of turns){ cur = rotv(cur, t); ds.push(cur); }
  return ds;
}

/** Try one turn sequence. Returns {turns, pts, segs} or null. */
function trySeq(P, d0, V, turns, stub){
  const ds = dirsFrom(d0, turns), n = ds.length;
  let ts = null;
  if (n === 1){
    const cross = d0[0]*V[1] - d0[1]*V[0], dot = d0[0]*V[0] + d0[1]*V[1];
    if (Math.abs(cross) > 1 || dot < stub) return null;
    ts = [dot];
  } else if (n === 2){
    const r = solve2(ds[0], ds[1], V);
    if (!r || r[0] < stub-1e-6 || r[1] < stub-1e-6) return null;
    ts = r;
  } else if (n === 3){
    let best = null;
    for (const fix of [0,1,2]){
      const rhs = [V[0]-stub*ds[fix][0], V[1]-stub*ds[fix][1]];
      const o = [0,1,2].filter(i => i !== fix);
      const r = solve2(ds[o[0]], ds[o[1]], rhs);
      if (!r) continue;
      const t = []; t[fix] = stub; t[o[0]] = r[0]; t[o[1]] = r[1];
      if (t.some(v => v < stub-1e-6)) continue;
      const sum = t[0]+t[1]+t[2];
      if (!best || sum < best.sum) best = {t, sum};
    }
    if (!best) return null;
    ts = best.t;
  } else if (n === 4){
    const rhs = [V[0]-stub*(ds[0][0]+ds[3][0]), V[1]-stub*(ds[0][1]+ds[3][1])];
    const r = solve2(ds[1], ds[2], rhs);
    if (!r || r[0] < stub-1e-6 || r[1] < stub-1e-6) return null;
    ts = [stub, r[0], r[1], stub];
  } else return null;

  const pts = [P.slice()];
  for (let i = 0; i < n; i++){
    const p = pts[i];
    pts.push([p[0] + ds[i][0]*ts[i], p[1] + ds[i][1]*ts[i]]);
  }
  return {turns, pts, segs: ts};
}

/** Fillet the interior vertices, clamping the radius where there isn't room. */
function applyFillets(sol, bendR){
  const {pts, segs, turns} = sol;
  const fillets = [];
  let length = segs.reduce((a,b) => a+b, 0);
  let tight = false;
  for (let i = 0; i < turns.length; i++){
    const d = Math.abs(turns[i]) * D2R;
    const tanHalf = Math.tan(d/2);
    const before = segs[i]   * (i > 0 ? 0.5 : 1);
    const after  = segs[i+1] * (i < turns.length-1 ? 0.5 : 1);
    const cap = Math.min(before, after);
    let R = bendR, T = R * tanHalf;
    if (T > cap){ T = cap; R = tanHalf > 1e-9 ? T/tanHalf : 0; tight = true; }
    fillets.push({R, T, deflect: Math.abs(turns[i])});
    length += R*d - 2*T;
  }
  return {...sol, fillets, length, tight};
}

/**
 * Route a pipe from face A to face B.
 * @returns {ok:true, pts, turns, segs, fillets, length, tight} | {ok:false, msg}
 */
function solveRoute(P, d0, Q, d2, opt){
  const V = [Q[0]-P[0], Q[1]-P[1]];
  const delta = signedAngle(d0, d2);
  const angles = [...new Set(opt.angles)].filter(a => a > 0 && a < 180).sort((a,b) => a-b);
  if (!angles.length && Math.abs(delta) > 1e-6)
    return {ok:false, msg:'no bend angles allowed'};

  const signed = [];
  for (const a of angles) signed.push(a, -a);

  const seqs = [];
  if (Math.abs(delta) < 1e-6) seqs.push([]);
  for (const a of signed) if (Math.abs(wrap(a - delta)) < 1e-6) seqs.push([a]);
  for (const a of signed) for (const b of signed)
    if (Math.abs(wrap(a+b - delta)) < 1e-6) seqs.push([a,b]);
  for (const a of signed) for (const b of signed) for (const c of signed)
    if (Math.abs(wrap(a+b+c - delta)) < 1e-6) seqs.push([a,b,c]);

  if (!seqs.length) return {ok:false, msg:'turn of ' + fmt1(delta) + '° not reachable with the allowed angles'};

  let best = null, blockedByStub = false;
  for (const s of seqs){
    const r = trySeq(P, d0, V, s, opt.stub);
    if (!r){ if (trySeq(P, d0, V, s, 0)) blockedByStub = true; continue; }
    const len = r.segs.reduce((a,b) => a+b, 0);
    const score = s.length*1e9 + len;
    if (!best || score < best.score) best = {...r, score};
  }
  if (!best) return {ok:false, msg: blockedByStub
      ? 'no room — reduce the minimum straight'
      : angles.length ? 'no route to that face with these angles'
                      : 'straight run does not line up — allow a bend angle'};
  return {ok:true, ...applyFillets(best, opt.bendR)};
}

function routeOf(cn){
  const A = byUid(cn.a.mh), B = byUid(cn.b.mh);
  if (!A || !B) return {ok:false, msg:'missing chamber'};
  const ga = faceGeom(A, cn.a.face), gb = faceGeom(B, cn.b.face);
  return solveRoute(ga.mid, ga.n, gb.mid, [-gb.n[0], -gb.n[1]], cn.pipe);
}
function recomputeRoutes(){
  for (const cn of state.connections) cn.route = routeOf(cn);
}

/* ==========================================================================
   VIEW
   ========================================================================== */

const W2S = p => [state.view.tx + p[0]*state.view.s, state.view.ty - p[1]*state.view.s];
const S2W = p => [(p[0]-state.view.tx)/state.view.s, (state.view.ty-p[1])/state.view.s];

function fitView(pad = 90){
  const r = STAGE.getBoundingClientRect();
  if (!state.chambers.length){ state.view = {tx:r.width/2, ty:r.height/2, s:0.05}; return draw(); }
  let minx=1e12, miny=1e12, maxx=-1e12, maxy=-1e12;
  const eat = p => { minx=Math.min(minx,p[0]); maxx=Math.max(maxx,p[0]);
                     miny=Math.min(miny,p[1]); maxy=Math.max(maxy,p[1]); };
  for (const c of state.chambers) corners(c, c.wall).forEach(eat);
  for (const cn of state.connections) if (cn.route && cn.route.ok) cn.route.pts.forEach(eat);
  const s = Math.min((r.width-pad*2)/Math.max(maxx-minx,1), (r.height-pad*2)/Math.max(maxy-miny,1));
  state.view.s = Math.max(0.0005, Math.min(3, s));
  state.view.tx = r.width/2  - (minx+maxx)/2 * state.view.s;
  state.view.ty = r.height/2 + (miny+maxy)/2 * state.view.s;
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

function gridStep(){
  const steps = [50,100,250,500,1000,2500,5000,10000,25000,50000,100000];
  for (const st of steps) if (st * state.view.s >= 55) return st;
  return steps[steps.length-1];
}

function routePathScreen(rt){
  const P = rt.pts.map(W2S), s = state.view.s;
  if (P.length < 2) return '';
  let d = `M${P[0][0].toFixed(1)},${P[0][1].toFixed(1)}`;
  for (let i = 1; i < P.length-1; i++){
    const f = rt.fillets[i-1], cur = P[i], prev = P[i-1], nxt = P[i+1];
    const Ts = f.T * s, Rs = f.R * s;
    if (Ts < 0.4 || Rs < 0.4){ d += ` L${cur[0].toFixed(1)},${cur[1].toFixed(1)}`; continue; }
    const u = norm([prev[0]-cur[0], prev[1]-cur[1]]);
    const v = norm([nxt[0]-cur[0],  nxt[1]-cur[1]]);
    const a1 = [cur[0]+u[0]*Ts, cur[1]+u[1]*Ts];
    const a2 = [cur[0]+v[0]*Ts, cur[1]+v[1]*Ts];
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
  out.push(`<defs><pattern id="hatch" patternUnits="userSpaceOnUse" width="${hs}" height="${hs}"
    patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="${hs}" stroke="${C.wall}" stroke-width="1"/></pattern></defs>`);

  /* grid */
  if (state.showGrid){
    const st = gridStep();
    const [x0, y1] = S2W([0,0]), [x1, y0] = S2W([W,H]);
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

  /* pipes, under the chamber linework */
  for (const cn of state.connections) out.push(drawConnection(cn));

  /* chambers */
  for (const c of state.chambers){
    const inner = corners(c, 0), outer = corners(c, c.wall);
    const on = c.uid === state.sel;
    const stroke = on ? C.sel : C.ink;
    const ext = c.intX + 2*c.wall;
    out.push(`<polygon points="${pts(inner)}" fill="${C.chamber}"/>`);
    out.push(`<path d="M${pts(outer).replace(/ /g,' L')} Z M${pts(inner).replace(/ /g,' L')} Z" fill="url(#hatch)" fill-rule="evenodd" opacity=".85"/>`);
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

function drawConnection(cn){
  const A = byUid(cn.a.mh), B = byUid(cn.b.mh);
  if (!A || !B) return '';
  const s = state.view.s, on = cn.uid === state.selConn, rt = cn.route;
  const ga = faceGeom(A, cn.a.face), gb = faceGeom(B, cn.b.face);
  const p = W2S(ga.mid), q = W2S(gb.mid);
  const out = [];

  /* not placed, or unroutable — show the intent as a thin guide */
  if (!cn.placed || !rt || !rt.ok){
    const col = rt && !rt.ok ? C.bad : (on ? C.sel : C.pipeGhost);
    if (rt && rt.ok && on){
      out.push(`<path d="${routePathScreen(rt)}" fill="none" stroke="${C.pipeEdge}" stroke-width="${Math.max(1, 2*cn.pipe.radius*s)}" stroke-linejoin="round" opacity=".22"/>`);
    }
    out.push(`<line x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}" stroke="${col}" stroke-width="${on?1.8:1.2}" stroke-dasharray="6 5" opacity=".85"/>`);
    out.push(`<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="${col}"/><circle cx="${q[0]}" cy="${q[1]}" r="3" fill="${col}"/>`);
    if (rt && !rt.ok){
      const mx = (p[0]+q[0])/2, my = (p[1]+q[1])/2;
      out.push(`<text x="${mx}" y="${my-7}" fill="${C.bad}" font-family="${C.mono}" font-size="10.5" text-anchor="middle">no route</text>`);
    }
    return out.join('');
  }

  /* placed */
  const d = routePathScreen(rt);
  const body = Math.max(1.5, 2*cn.pipe.radius*s);
  const edge = on ? C.sel : C.pipeEdge;
  out.push(`<path d="${d}" fill="none" stroke="${edge}" stroke-width="${body}" stroke-linejoin="round" stroke-linecap="butt" opacity=".95"/>`);
  if (body > 4)
    out.push(`<path d="${d}" fill="none" stroke="${C.pipeBody}" stroke-width="${body-2.4}" stroke-linejoin="round" stroke-linecap="butt"/>`);
  out.push(`<path d="${d}" fill="none" stroke="${edge}" stroke-width="1" stroke-dasharray="9 4 2 4" opacity=".8"/>`);
  out.push(`<circle cx="${p[0]}" cy="${p[1]}" r="3.2" fill="${edge}"/><circle cx="${q[0]}" cy="${q[1]}" r="3.2" fill="${edge}"/>`);

  if (state.showDims){
    rt.fillets.forEach((f, i) => {
      const v = W2S(rt.pts[i+1]);
      if (body > 5)
        out.push(`<text x="${v[0]+7}" y="${v[1]-6}" fill="${C.inkDim}" font-family="${C.mono}" font-size="10">${fmt1(f.deflect)}°</text>`);
    });
    const mid = rt.pts[Math.floor(rt.pts.length/2)];
    const m = W2S(mid);
    if (rt.length*s > 80)
      out.push(`<text x="${m[0]}" y="${m[1]-body/2-7}" fill="${edge}" font-family="${C.mono}" font-size="10.5" text-anchor="middle">${metres(rt.length)}</text>`);
  }
  return out.join('');
}

function faceMarker(f, colour){
  const a = W2S(f.p1), b = W2S(f.p2), m = W2S(f.mid);
  const u = norm([f.n[0], -f.n[1]]);
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
  for (const c of state.chambers)
    for (const f of FACES){
      const g = faceGeom(c, f);
      const d = distToSeg(world, g.p1, g.p2);
      if (d < tol && d < bestD){ bestD = d; best = {mh:c.uid, face:f}; }
    }
  return best;
}
function hitChamber(world){
  for (let i = state.chambers.length-1; i >= 0; i--)
    if (pointInPoly(world, corners(state.chambers[i], state.chambers[i].wall))) return state.chambers[i];
  return null;
}
function hitConnection(world, tolPx = 8){
  let best = null, bestD = Infinity;
  for (const cn of state.connections){
    const rt = cn.route;
    let poly;
    if (cn.placed && rt && rt.ok) poly = rt.pts;
    else {
      const A = byUid(cn.a.mh), B = byUid(cn.b.mh);
      if (!A || !B) continue;
      poly = [faceGeom(A, cn.a.face).mid, faceGeom(B, cn.b.face).mid];
    }
    const tol = Math.max(tolPx/state.view.s, cn.placed ? cn.pipe.radius : 0);
    for (let i = 0; i < poly.length-1; i++){
      const d = distToSeg(world, poly[i], poly[i+1]);
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
  if (c){ selectChamber(c.uid); drag = {kind:'move', uid:c.uid, dx:wp[0]-c.x, dy:wp[1]-c.y}; return; }

  const cn = hitConnection(wp);
  if (cn){ selectConn(cn.uid); return; }

  selectChamber(null);
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
    const c = byUid(drag.uid);
    c.x = snap(wp[0]-drag.dx); c.y = snap(wp[1]-drag.dy);
    renderProps(); renderConnections(); return draw();
  }

  const f = hitFace(wp);
  const changed = JSON.stringify(f) !== JSON.stringify(state.hoverFace);
  state.hoverFace = f;
  showCallout(f, sp);
  STAGE.style.cursor = state.mode === 'connect' ? (f ? 'pointer' : 'crosshair')
                     : hitChamber(wp) ? 'move' : hitConnection(wp) ? 'pointer' : 'crosshair';
  if (changed) draw();
});

STAGE.addEventListener('pointerup', () => { drag = null; });
STAGE.addEventListener('pointerleave', () => {
  state.hoverFace = null; showCallout(null); draw();
  document.getElementById('rx').textContent = '—';
  document.getElementById('ry').textContent = '—';
});
STAGE.addEventListener('contextmenu', e => e.preventDefault());

STAGE.addEventListener('wheel', e => {
  e.preventDefault();
  const r = STAGE.getBoundingClientRect();
  const sp = [e.clientX-r.left, e.clientY-r.top];
  const before = S2W(sp);
  state.view.s = Math.max(0.0004, Math.min(4, state.view.s * Math.exp(-e.deltaY*0.0016)));
  const after = S2W(sp);
  state.view.tx += (after[0]-before[0]) * state.view.s;
  state.view.ty -= (after[1]-before[1]) * state.view.s;
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
   CONNECTIONS
   ========================================================================== */

function pickFace(f){
  if (!state.pending){ state.pending = f; draw(); return; }
  if (state.pending.mh === f.mh && state.pending.face === f.face){ state.pending = null; draw(); return; }
  const same = (x,y) => x.mh === y.mh && x.face === y.face;
  const dup = state.connections.find(c =>
    (same(c.a, state.pending) && same(c.b, f)) || (same(c.b, state.pending) && same(c.a, f)));
  if (dup){ state.pending = null; selectConn(dup.uid); return; }
  const cn = {uid: uid(), a: state.pending, b: f, placed: false, pipe: {...state.pipeDefaults, angles:[...state.pipeDefaults.angles]}, route: null};
  state.connections.push(cn);
  state.pending = null;
  selectConn(cn.uid);
}

function disconnect(u){
  state.connections = state.connections.filter(c => c.uid !== u);
  if (state.selConn === u) state.selConn = null;
  renderConnections(); renderPipe(); draw();
}

function connLabel(cn){
  const A = byUid(cn.a.mh), B = byUid(cn.b.mh);
  return `${A ? A.ref : '?'}·${cn.a.face} → ${B ? B.ref : '?'}·${cn.b.face}`;
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
    const rt = cn.route;
    const cls = !rt || !rt.ok ? 'bad' : cn.placed ? 'placed' : '';
    const meta = !rt || !rt.ok ? 'no route'
               : cn.placed ? metres(rt.length) + (rt.tight ? ' ⚠' : '')
               : 'not placed';
    return `<div class="item ${cn.uid === state.selConn ? 'on' : ''}" data-conn="${cn.uid}">
      <span class="dot ${cls}"></span><span>${esc(connLabel(cn))}</span>
      <span class="meta">${meta}</span>
      <button class="x" data-del="${cn.uid}" title="Disconnect">×</button></div>`;
  }).join('') + '</div>';

  box.querySelectorAll('[data-conn]').forEach(el => el.onclick = () => selectConn(el.dataset.conn));
  box.querySelectorAll('[data-del]').forEach(b => b.onclick = ev => { ev.stopPropagation(); disconnect(b.dataset.del); });
}

/* ==========================================================================
   PANEL
   ========================================================================== */

function selectChamber(u){ state.sel = u; if (u) state.selConn = null;
  renderProps(); renderConnections(); renderPipe(); draw(); }
function selectConn(u){ state.selConn = u; if (u) state.sel = null;
  renderProps(); renderConnections(); renderPipe(); draw(); }

function numRow(id, label, val, step, unit){
  return `<div class="row"><label for="${id}">${label}</label>
    <input type="number" id="${id}" value="${val}" step="${step}"><span class="unit">${unit}</span></div>`;
}

function renderProps(){
  const box = document.getElementById('props');
  const c = byUid(state.sel);
  if (!c){ box.innerHTML = `<div class="empty">Nothing selected. Click a chamber to edit it, or add one.</div>`; return; }
  box.innerHTML =
    `<div class="row"><label for="pRef">Reference</label><input type="text" id="pRef" value="${esc(c.ref)}"><span class="unit"></span></div>` +
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
       <b>Faces</b> ${FACES.map(f => f+' '+fmt(faceGeom(c,f).width)).join('  ')}
     </div>
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
    if (state.square){ c.intY = c.intX; renderProps(); renderConnections(); draw(); }
  };
  document.getElementById('pDup').onclick = () => {
    const n = makeChamber({...c, uid: uid(), ref: nextRef(), x: c.x + c.intX + 2*c.wall + 1000});
    state.chambers.push(n); selectChamber(n.uid);
  };
  document.getElementById('pDel').onclick = () => removeChamber(c.uid);
}

function removeChamber(u){
  state.chambers = state.chambers.filter(c => c.uid !== u);
  state.connections = state.connections.filter(c => c.a.mh !== u && c.b.mh !== u);
  state.sel = null; state.pending = null;
  renderProps(); renderConnections(); renderPipe(); draw();
}

/** Pipe settings — for the selected connection, or the defaults for new ones. */
function renderPipe(){
  const box = document.getElementById('pipe');
  const cn = connBy(state.selConn);
  const p  = cn ? cn.pipe : state.pipeDefaults;
  const rt = cn ? cn.route : null;

  document.getElementById('pipeWho').textContent = cn ? connLabel(cn) : 'defaults for new runs';

  box.innerHTML =
    numRow('qRad','Pipe radius', p.radius, 25, 'mm') +
    numRow('qBend','Bend radius', p.bendR, 50, 'mm') +
    numRow('qStub','Min straight', p.stub, 50, 'mm') +
    `<div class="row" style="margin-top:4px"><label>Bend angles allowed</label></div>
     <div class="chips" id="qAngles">${ANGLE_OPTIONS.map(a =>
        `<button class="chip ${p.angles.includes(a)?'on':''}" data-ang="${a}">${a}°</button>`).join('')}</div>` +
    (cn ? `<div class="derived">
        <b>Bore</b> ${fmt(p.radius*2)} mm dia<br>
        ${rt && rt.ok
          ? `<b>Bends</b> ${rt.turns.length ? rt.turns.map(t => fmt1(Math.abs(t))+'°').join(' · ') : 'none — straight run'}<br>
             <b>Straights</b> ${rt.segs.map(v => fmt(v)).join(' · ')} mm<br>
             <b>Centreline</b> ${metres(rt.length)} face to face`
          : `<span style="color:var(--bad)">${esc(rt ? rt.msg : '')}</span>`}
      </div>
      ${rt && rt.ok && rt.tight ? `<div class="note bad">Bend radius reduced to fit the straights.</div>` : ''}
      <div class="btnrow">
        <button id="qPlace" class="primary" ${rt && rt.ok ? '' : 'disabled'}>${cn.placed ? 'Update line' : 'Place line'}</button>
        <button id="qDrop" class="warn">Disconnect</button>
      </div>
      ${cn.placed ? '' : `<div class="note">Not placed yet — the dashed guide shows the face pair. Press Place line to route the pipe.</div>`}`
    : `<div class="note">No run selected. These values are applied to the next connection you make. Pick a run from the list above to edit it.</div>`);

  const bindP = (id, key) => {
    const el = document.getElementById(id);
    el.addEventListener('input', () => {
      const v = Number(el.value);
      if (!Number.isFinite(v) || v < 0) return;
      p[key] = v;
      renderConnections(); draw(); refreshPipeReadout();
    });
  };
  bindP('qRad','radius'); bindP('qBend','bendR'); bindP('qStub','stub');

  box.querySelectorAll('[data-ang]').forEach(b => b.onclick = () => {
    const a = Number(b.dataset.ang);
    const i = p.angles.indexOf(a);
    if (i >= 0) p.angles.splice(i,1); else p.angles.push(a);
    p.angles.sort((x,y) => x-y);
    b.classList.toggle('on');
    renderConnections(); draw(); refreshPipeReadout();
  });

  if (cn){
    document.getElementById('qPlace').onclick = () => { cn.placed = true; renderConnections(); renderPipe(); draw(); };
    document.getElementById('qDrop').onclick  = () => disconnect(cn.uid);
  }
}

/** Re-render just the derived block + buttons without losing input focus. */
function refreshPipeReadout(){
  const cn = connBy(state.selConn);
  if (!cn) return;
  const active = document.activeElement && document.activeElement.id;
  const box = document.getElementById('pipe');
  const der = box.querySelector('.derived');
  if (!der) return;
  const rt = cn.route, p = cn.pipe;
  der.innerHTML = `<b>Bore</b> ${fmt(p.radius*2)} mm dia<br>` + (rt && rt.ok
    ? `<b>Bends</b> ${rt.turns.length ? rt.turns.map(t => fmt1(Math.abs(t))+'°').join(' · ') : 'none — straight run'}<br>
       <b>Straights</b> ${rt.segs.map(v => fmt(v)).join(' · ')} mm<br>
       <b>Centreline</b> ${metres(rt.length)} face to face`
    : `<span style="color:var(--bad)">${esc(rt ? rt.msg : '')}</span>`);
  const btn = document.getElementById('qPlace');
  if (btn) btn.disabled = !(rt && rt.ok);
  if (active) { const el = document.getElementById(active); if (el && el.focus) el.focus(); }
}

/* ==========================================================================
   CONTROLS
   ========================================================================== */

document.getElementById('btnAdd').onclick = () => {
  const r = STAGE.getBoundingClientRect();
  const centre = S2W([r.width/2, r.height/2]);
  const base = state.chambers[state.chambers.length-1];
  const c = makeChamber({
    x: snap(centre[0]), y: snap(centre[1]),
    intX: base ? base.intX : 1200, intY: base ? base.intY : 1200, wall: base ? base.wall : 150
  });
  state.chambers.push(c);
  selectChamber(c.uid);
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

document.getElementById('btnExport').onclick = () => {
  recomputeRoutes();
  const data = {
    units:'mm', axes:'+X east, +Y north',
    chambers: state.chambers.map(({uid, ...rest}) => rest),
    connections: state.connections.map(cn => {
      const rt = cn.route;
      return {
        from: {ref: byUid(cn.a.mh)?.ref, face: cn.a.face},
        to:   {ref: byUid(cn.b.mh)?.ref, face: cn.b.face},
        placed: cn.placed,
        pipe: {...cn.pipe},
        route: rt && rt.ok ? {
          vertices: rt.pts.map(p => [Math.round(p[0]), Math.round(p[1])]),
          bends: rt.turns.map((t,i) => ({deflection:t, radius: Math.round(rt.fillets[i].R)})),
          straights: rt.segs.map(v => Math.round(v)),
          centrelineLength: Math.round(rt.length)
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
      state.chambers = (d.chambers||[]).map(c => makeChamber({...c, uid: uid()}));
      const byRef = r => state.chambers.find(c => c.ref === r);
      state.connections = (d.connections||[]).map(cn => {
        const A = byRef(cn.from?.ref), B = byRef(cn.to?.ref);
        if (!A || !B) return null;
        return {uid: uid(), a:{mh:A.uid, face:cn.from.face}, b:{mh:B.uid, face:cn.to.face},
                placed: !!cn.placed,
                pipe: {...state.pipeDefaults, ...(cn.pipe||{}), angles:[...((cn.pipe&&cn.pipe.angles)||state.pipeDefaults.angles)]},
                route:null};
      }).filter(Boolean);
      state.sel = null; state.selConn = null;
      renderProps(); renderConnections(); renderPipe(); fitView();
    } catch(err){ alert('That file is not a plan export. Expected JSON with a chambers array.'); }
    e.target.value = '';
  };
  rd.readAsText(f);
};

document.getElementById('btnClear').onclick = () => {
  if (!state.chambers.length || confirm('Remove every chamber and pipe run?')){
    state.chambers = []; state.connections = []; state.sel = null; state.selConn = null; state.pending = null;
    renderProps(); renderConnections(); renderPipe(); draw();
  }
};

document.addEventListener('keydown', e => {
  if (/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  const c = byUid(state.sel);
  if (e.key === 'Delete' || e.key === 'Backspace'){
    if (state.selConn){ e.preventDefault(); disconnect(state.selConn); }
    else if (c){ e.preventDefault(); removeChamber(c.uid); }
  } else if (e.key === 'Escape'){
    state.pending = null; state.selConn = null; selectChamber(null);
  } else if (e.key === 'f' || e.key === 'F'){ fitView();
  } else if (e.key.startsWith('Arrow') && c){
    e.preventDefault();
    const d = (state.snap || 10) * (e.shiftKey ? 10 : 1);
    if (e.key === 'ArrowLeft')  c.x -= d;
    if (e.key === 'ArrowRight') c.x += d;
    if (e.key === 'ArrowUp')    c.y += d;
    if (e.key === 'ArrowDown')  c.y -= d;
    renderProps(); renderConnections(); draw();
  }
});

new ResizeObserver(() => draw()).observe(STAGE);

/* ==========================================================================
   START
   ========================================================================== */

state.chambers = [
  makeChamber({ref:'MH01', x:0,     y:0,    intX:1200, intY:1200, wall:150}),
  makeChamber({ref:'MH02', x:9000,  y:0,    intX:1500, intY:1500, wall:200}),
  makeChamber({ref:'MH03', x:17500, y:3800, intX:1200, intY:1200, wall:150, rot:45})
];
const demoPipe = () => ({radius:150, bendR:600, stub:500, angles:[22.5,45,90]});
state.connections = [
  {uid:uid(), a:{mh:state.chambers[0].uid, face:'E'}, b:{mh:state.chambers[1].uid, face:'W'},
   placed:true,  pipe:demoPipe(), route:null},
  {uid:uid(), a:{mh:state.chambers[1].uid, face:'E'}, b:{mh:state.chambers[2].uid, face:'W'},
   placed:false, pipe:demoPipe(), route:null}
];
renderProps(); renderConnections(); renderPipe(); fitView();
