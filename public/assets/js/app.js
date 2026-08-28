/* ==========================================================================
   MANHOLE PLAN — square chambers drawn as internal box + wall thickness.
   Units: millimetres. World axes: +X east, +Y north.
   ========================================================================== */

const C = {
  ink:'#dfe6ef', inkDim:'#8894a4', inkFaint:'#5b6675',
  wall:'#59657a', chamber:'#161d27',
  sel:'#ffb454', pick:'#35c3e8', pipe:'#35c3e8',
  gridMinor:'#1a212b', gridMajor:'#27313f',
  axisX:'#5c3436', axisY:'#2f5c40',
  mono:'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
};

const SVG = document.getElementById('svg');
const STAGE = document.getElementById('stage');

const state = {
  chambers: [],          // see makeChamber()
  connections: [],       // {uid, a:{mh,face}, b:{mh,face}}
  view: {tx:0, ty:0, s:0.04},   // s = pixels per mm
  sel: null,             // selected chamber uid
  hoverFace: null,       // {mh, face}
  mode: 'select',        // 'select' | 'connect'
  pending: null,         // first face picked while connecting
  snap: 50,
  showGrid: true,
  showDims: true,
  square: true,
  cursor: null           // world coords under pointer
};

let uidSeq = 1;
const uid = () => 'e' + (uidSeq++);

function makeChamber(o = {}){
  return Object.assign({
    uid: uid(),
    ref: nextRef(),
    x: 0, y: 0,          // centre of chamber, mm
    intX: 1200,          // internal clear dimension along local X
    intY: 1200,          // internal clear dimension along local Y
    wall: 150,           // wall thickness, mm
    rot: 0               // rotation about centre, degrees CCW
  }, o);
}

function nextRef(){
  let n = 1;
  const used = new Set(state.chambers.map(c => c.ref));
  while (used.has('MH' + String(n).padStart(2,'0'))) n++;
  return 'MH' + String(n).padStart(2,'0');
}

const byUid = u => state.chambers.find(c => c.uid === u);

/* ==========================================================================
   GEOMETRY
   Faces are named in the chamber's LOCAL frame: N = +Y, E = +X, S = -Y, W = -X.
   faceGeom() returns the INTERNAL face — the inside surface of that wall —
   in world coordinates. This is the anchor the connection logic works from.
   ========================================================================== */

const FACES = ['N','E','S','W'];

function localFace(c, f){
  const a = c.intX/2, b = c.intY/2;
  return {
    N: {p1:[-a, b], p2:[ a, b], n:[0, 1]},
    E: {p1:[ a, b], p2:[ a,-b], n:[1, 0]},
    S: {p1:[ a,-b], p2:[-a,-b], n:[0,-1]},
    W: {p1:[-a,-b], p2:[-a, b], n:[-1,0]}
  }[f];
}

function toWorld(c, p){
  const r = c.rot * Math.PI/180, co = Math.cos(r), si = Math.sin(r);
  return [c.x + p[0]*co - p[1]*si, c.y + p[0]*si + p[1]*co];
}
function rotVec(c, v){
  const r = c.rot * Math.PI/180, co = Math.cos(r), si = Math.sin(r);
  return [v[0]*co - v[1]*si, v[0]*si + v[1]*co];
}

/** Internal face of chamber c on side f, in world mm. */
function faceGeom(c, f){
  const lf = localFace(c, f);
  const p1 = toWorld(c, lf.p1), p2 = toWorld(c, lf.p2);
  const n  = rotVec(c, lf.n);                         // outward unit normal
  const mid = [(p1[0]+p2[0])/2, (p1[1]+p2[1])/2];
  return {
    mh: c.uid, ref: c.ref, face: f,
    p1, p2, mid, n,
    width: Math.hypot(p2[0]-p1[0], p2[1]-p1[1]),      // clear width of the face
    outerMid: [mid[0] + n[0]*c.wall, mid[1] + n[1]*c.wall],  // same point on the external face
    bearing: (450 - Math.atan2(n[1], n[0]) * 180/Math.PI) % 360
  };
}

/** Corners in world mm. inset 0 = internal box, inset = wall gives external box. */
function corners(c, inset){
  const a = c.intX/2 + inset, b = c.intY/2 + inset;
  return [[-a,-b],[a,-b],[a,b],[-a,b]].map(p => toWorld(c, p));
}

function pointInPoly(pt, poly){
  let inside = false;
  for (let i = 0, j = poly.length-1; i < poly.length; j = i++){
    const [xi,yi] = poly[i], [xj,yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) &&
        pt[0] < (xj-xi)*(pt[1]-yi)/(yj-yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSeg(p, a, b){
  const vx = b[0]-a[0], vy = b[1]-a[1];
  const wx = p[0]-a[0], wy = p[1]-a[1];
  const L2 = vx*vx + vy*vy;
  const t = L2 ? Math.max(0, Math.min(1, (wx*vx + wy*vy)/L2)) : 0;
  return Math.hypot(p[0]-(a[0]+t*vx), p[1]-(a[1]+t*vy));
}

/* ==========================================================================
   VIEW TRANSFORM  (world mm  <->  screen px, y flipped so +Y is up)
   ========================================================================== */

const W2S = p => [state.view.tx + p[0]*state.view.s, state.view.ty - p[1]*state.view.s];
const S2W = p => [(p[0]-state.view.tx)/state.view.s, (state.view.ty-p[1])/state.view.s];

function fitView(pad = 90){
  const r = STAGE.getBoundingClientRect();
  if (!state.chambers.length){
    state.view = {tx:r.width/2, ty:r.height/2, s:0.05};
    return draw();
  }
  let minx=1e12, miny=1e12, maxx=-1e12, maxy=-1e12;
  for (const c of state.chambers)
    for (const p of corners(c, c.wall)){
      minx=Math.min(minx,p[0]); maxx=Math.max(maxx,p[0]);
      miny=Math.min(miny,p[1]); maxy=Math.max(maxy,p[1]);
    }
  const s = Math.min((r.width-pad*2)/Math.max(maxx-minx,1), (r.height-pad*2)/Math.max(maxy-miny,1));
  state.view.s = Math.max(0.0005, Math.min(3, s));
  state.view.tx = r.width/2  - (minx+maxx)/2 * state.view.s;
  state.view.ty = r.height/2 + (miny+maxy)/2 * state.view.s;
  draw();
}

/* ==========================================================================
   DRAW
   ========================================================================== */

const esc = s => String(s).replace(/[&<>]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
const pts = arr => arr.map(p => { const q = W2S(p); return q[0].toFixed(1)+','+q[1].toFixed(1); }).join(' ');
const fmt = v => Math.round(v).toLocaleString('en-GB');

function gridStep(){
  const steps = [50,100,250,500,1000,2500,5000,10000,25000,50000,100000];
  for (const st of steps) if (st * state.view.s >= 55) return st;
  return steps[steps.length-1];
}

function draw(){
  const r = STAGE.getBoundingClientRect();
  const W = r.width, H = r.height, s = state.view.s;
  const out = [];

  // -- defs: 45° wall hatch, scaled with the view so it reads as a material
  const hs = Math.max(3.5, Math.min(15, 0.42 * 150 * s + 3));
  out.push(`<defs><pattern id="hatch" patternUnits="userSpaceOnUse" width="${hs}" height="${hs}"
    patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="${hs}"
    stroke="${C.wall}" stroke-width="1"/></pattern></defs>`);

  // -- grid
  if (state.showGrid){
    const st = gridStep();
    const [x0,y1] = S2W([0,0]), [x1,y0] = S2W([W,H]);
    const g = [];
    for (let x = Math.ceil(x0/st)*st; x <= x1; x += st){
      const sx = W2S([x,0])[0], major = Math.abs(Math.round(x/st)) % 5 === 0;
      g.push(`<line x1="${sx.toFixed(1)}" y1="0" x2="${sx.toFixed(1)}" y2="${H}"
        stroke="${major?C.gridMajor:C.gridMinor}" stroke-width="1"/>`);
    }
    for (let y = Math.ceil(y0/st)*st; y <= y1; y += st){
      const sy = W2S([0,y])[1], major = Math.abs(Math.round(y/st)) % 5 === 0;
      g.push(`<line x1="0" y1="${sy.toFixed(1)}" x2="${W}" y2="${sy.toFixed(1)}"
        stroke="${major?C.gridMajor:C.gridMinor}" stroke-width="1"/>`);
    }
    out.push(g.join(''));
    const o = W2S([0,0]);
    out.push(`<line x1="0" y1="${o[1]}" x2="${W}" y2="${o[1]}" stroke="${C.axisX}" stroke-width="1"/>`);
    out.push(`<line x1="${o[0]}" y1="0" x2="${o[0]}" y2="${H}" stroke="${C.axisY}" stroke-width="1"/>`);
  }

  // -- connections (drawn under the chambers so linework stays clean)
  for (const cn of state.connections){
    const A = byUid(cn.a.mh), B = byUid(cn.b.mh);
    if (!A || !B) continue;
    const fa = faceGeom(A, cn.a.face), fb = faceGeom(B, cn.b.face);
    const p = W2S(fa.mid), q = W2S(fb.mid);
    const len = Math.hypot(fb.mid[0]-fa.mid[0], fb.mid[1]-fa.mid[1]);
    out.push(`<line x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}"
      stroke="${C.pipe}" stroke-width="1.6" stroke-dasharray="7 4" opacity=".9"/>`);
    out.push(`<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="${C.pipe}"/>`);
    out.push(`<circle cx="${q[0]}" cy="${q[1]}" r="3" fill="${C.pipe}"/>`);
    if (state.showDims && s * len > 70){
      const mx = (p[0]+q[0])/2, my = (p[1]+q[1])/2;
      let ang = Math.atan2(q[1]-p[1], q[0]-p[0]) * 180/Math.PI;
      if (ang > 90 || ang < -90) ang += 180;
      out.push(`<text x="${mx}" y="${my-6}" transform="rotate(${ang.toFixed(1)} ${mx} ${my-6})"
        fill="${C.pipe}" font-family="${C.mono}" font-size="10.5" text-anchor="middle"
        opacity=".95">${fmt(len)}</text>`);
    }
  }

  // -- chambers
  for (const c of state.chambers){
    const inner = corners(c, 0), outer = corners(c, c.wall);
    const selected = c.uid === state.sel;
    const stroke = selected ? C.sel : C.ink;
    const extW = c.intX + 2*c.wall, extH = c.intY + 2*c.wall;

    // chamber void
    out.push(`<polygon points="${pts(inner)}" fill="${C.chamber}"/>`);
    // wall annulus, hatched
    out.push(`<path d="M${pts(outer).replace(/ /g,' L')} Z M${pts(inner).replace(/ /g,' L')} Z"
      fill="url(#hatch)" fill-rule="evenodd" opacity=".85"/>`);
    // linework
    out.push(`<polygon points="${pts(outer)}" fill="none" stroke="${stroke}" stroke-width="${selected?2:1.4}"/>`);
    out.push(`<polygon points="${pts(inner)}" fill="none" stroke="${stroke}" stroke-width="${selected?1.6:1.1}" opacity=".9"/>`);

    // centre mark
    const ctr = W2S([c.x, c.y]);
    if (extW * s > 34){
      out.push(`<line x1="${ctr[0]-5}" y1="${ctr[1]}" x2="${ctr[0]+5}" y2="${ctr[1]}" stroke="${stroke}" stroke-width="1" opacity=".5"/>`);
      out.push(`<line x1="${ctr[0]}" y1="${ctr[1]-5}" x2="${ctr[0]}" y2="${ctr[1]+5}" stroke="${stroke}" stroke-width="1" opacity=".5"/>`);
    }
    // annotation
    if (extW * s > 46){
      out.push(`<text x="${ctr[0]}" y="${ctr[1]-6}" fill="${stroke}" font-family="${C.mono}"
        font-size="12" text-anchor="middle" letter-spacing="1">${esc(c.ref)}</text>`);
      if (state.showDims && extW * s > 96)
        out.push(`<text x="${ctr[0]}" y="${ctr[1]+11}" fill="${C.inkDim}" font-family="${C.mono}"
          font-size="10" text-anchor="middle">${fmt(c.intX)}×${fmt(c.intY)}  w${fmt(c.wall)}</text>`);
    }
  }

  // -- picked face (first half of a connection)
  if (state.pending){
    const c = byUid(state.pending.mh);
    if (c) out.push(faceMarker(faceGeom(c, state.pending.face), C.sel));
  }
  // -- hovered face
  if (state.hoverFace){
    const c = byUid(state.hoverFace.mh);
    if (c) out.push(faceMarker(faceGeom(c, state.hoverFace.face), C.pick));
  }

  SVG.setAttribute('viewBox', `0 0 ${W} ${H}`);
  SVG.innerHTML = out.join('');
  drawScaleBar();
  document.getElementById('rz').textContent = (state.view.s*100).toFixed(1) + ' px/cm';
}

function faceMarker(f, colour){
  const a = W2S(f.p1), b = W2S(f.p2), m = W2S(f.mid);
  const n = [f.n[0]*state.view.s, -f.n[1]*state.view.s];
  const L = Math.hypot(n[0],n[1]) || 1;
  const ux = n[0]/L, uy = n[1]/L;
  return `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${colour}" stroke-width="3.4" stroke-linecap="round"/>`
       + `<line x1="${a[0]-ux*6}" y1="${a[1]-uy*6}" x2="${a[0]+ux*6}" y2="${a[1]+uy*6}" stroke="${colour}" stroke-width="1.4"/>`
       + `<line x1="${b[0]-ux*6}" y1="${b[1]-uy*6}" x2="${b[0]+ux*6}" y2="${b[1]+uy*6}" stroke="${colour}" stroke-width="1.4"/>`
       + `<circle cx="${m[0]}" cy="${m[1]}" r="3.2" fill="${colour}"/>`;
}

function drawScaleBar(){
  const el = document.getElementById('scalebar');
  const opts = [100,200,500,1000,2000,5000,10000,20000,50000,100000];
  let pick = opts[0];
  for (const o of opts){ pick = o; if (o * state.view.s >= 70) break; }
  const px = pick * state.view.s;
  el.querySelector('.bar').style.width = px + 'px';
  el.querySelector('span').textContent = pick >= 1000 ? (pick/1000) + ' m' : pick + ' mm';
}

/* ==========================================================================
   HIT TESTING
   ========================================================================== */

function hitFace(world, tolPx = 9){
  const tol = tolPx / state.view.s;
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
  for (let i = state.chambers.length-1; i >= 0; i--){
    const c = state.chambers[i];
    if (pointInPoly(world, corners(c, c.wall))) return c;
  }
  return null;
}

/* ==========================================================================
   POINTER
   ========================================================================== */

let drag = null;

STAGE.addEventListener('pointerdown', e => {
  if (e.button === 2) return;
  STAGE.setPointerCapture(e.pointerId);
  const r = STAGE.getBoundingClientRect();
  const sp = [e.clientX - r.left, e.clientY - r.top];
  const wp = S2W(sp);

  if (state.mode === 'connect'){
    const f = hitFace(wp, 12);
    if (f) pickFace(f);
    else { state.pending = null; draw(); }
    return;
  }

  const c = hitChamber(wp);
  if (c){
    select(c.uid);
    drag = {kind:'move', uid:c.uid, dx:wp[0]-c.x, dy:wp[1]-c.y};
  } else {
    select(null);
    drag = {kind:'pan', sx:sp[0], sy:sp[1], tx:state.view.tx, ty:state.view.ty};
  }
});

STAGE.addEventListener('pointermove', e => {
  const r = STAGE.getBoundingClientRect();
  const sp = [e.clientX - r.left, e.clientY - r.top];
  const wp = S2W(sp);
  state.cursor = wp;
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
    renderProps(); return draw();
  }

  const f = hitFace(wp);
  const changed = JSON.stringify(f) !== JSON.stringify(state.hoverFace);
  state.hoverFace = f;
  showCallout(f, sp);
  STAGE.style.cursor = state.mode === 'connect' ? (f ? 'pointer' : 'crosshair')
                     : (hitChamber(wp) ? 'move' : 'crosshair');
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
  const sp = [e.clientX - r.left, e.clientY - r.top];
  const before = S2W(sp);
  const k = Math.exp(-e.deltaY * 0.0016);
  state.view.s = Math.max(0.0004, Math.min(4, state.view.s * k));
  const after = S2W(sp);
  state.view.tx += (after[0]-before[0]) * state.view.s;
  state.view.ty -= (after[1]-before[1]) * state.view.s;
  draw();
}, {passive:false});

function snap(v){
  return state.snap > 0 ? Math.round(v/state.snap)*state.snap : Math.round(v);
}

function showCallout(f, sp){
  const el = document.getElementById('callout');
  if (!f){ el.style.display = 'none'; return; }
  const c = byUid(f.mh), g = faceGeom(c, f.face);
  el.innerHTML =
    `<u>${esc(c.ref)} · ${f.face} face</u>\n` +
    `internal face   ${fmt(g.width)} wide\n` +
    `mid  X ${fmt(g.mid[0])}  Y ${fmt(g.mid[1])}\n` +
    `outward bearing ${g.bearing.toFixed(1)}°`;
  el.style.display = 'block';
  el.style.left = Math.min(sp[0] + 16, STAGE.clientWidth - 210) + 'px';
  el.style.top  = Math.min(sp[1] + 16, STAGE.clientHeight - 90) + 'px';
}

/* ==========================================================================
   CONNECTIONS
   Placeholder: a straight centreline between the two internal face midpoints.
   Replace pickFace()/the connection block in draw() when the real routing,
   offset and invert logic goes in — the geometry it needs is on faceGeom().
   ========================================================================== */

function pickFace(f){
  if (!state.pending){ state.pending = f; draw(); return; }
  if (state.pending.mh === f.mh && state.pending.face === f.face){ state.pending = null; draw(); return; }
  const dup = state.connections.some(c =>
    (c.a.mh===state.pending.mh && c.a.face===state.pending.face && c.b.mh===f.mh && c.b.face===f.face) ||
    (c.b.mh===state.pending.mh && c.b.face===state.pending.face && c.a.mh===f.mh && c.a.face===f.face));
  if (!dup) state.connections.push({uid: uid(), a: state.pending, b: f});
  state.pending = null;
  renderConnections(); draw();
}

function connLength(cn){
  const A = byUid(cn.a.mh), B = byUid(cn.b.mh);
  if (!A || !B) return 0;
  const a = faceGeom(A, cn.a.face).mid, b = faceGeom(B, cn.b.face).mid;
  return Math.hypot(b[0]-a[0], b[1]-a[1]);
}

function renderConnections(){
  const box = document.getElementById('connList');
  document.getElementById('connCount').textContent = state.connections.length ? `(${state.connections.length})` : '';
  if (!state.connections.length){
    box.innerHTML = `<div class="empty">None yet. Choose <b>Connect faces</b>, then click an internal face on one chamber and an internal face on the next.</div>`;
    return;
  }
  box.innerHTML = '<div class="list">' + state.connections.map(cn => {
    const A = byUid(cn.a.mh), B = byUid(cn.b.mh);
    return `<div class="item" data-conn="${cn.uid}">
      <span>${esc(A?A.ref:'?')}·${cn.a.face} → ${esc(B?B.ref:'?')}·${cn.b.face}</span>
      <span class="len">${fmt(connLength(cn))}</span>
      <button class="x" data-del="${cn.uid}" title="Remove">×</button></div>`;
  }).join('') + '</div>';
  box.querySelectorAll('[data-del]').forEach(b => b.onclick = ev => {
    ev.stopPropagation();
    state.connections = state.connections.filter(c => c.uid !== b.dataset.del);
    renderConnections(); draw();
  });
}

/* ==========================================================================
   PROPERTIES PANEL
   ========================================================================== */

function select(u){ state.sel = u; renderProps(); draw(); }

function numRow(id, label, val, step, unit){
  return `<div class="row"><label for="${id}">${label}</label>
    <input type="number" id="${id}" value="${val}" step="${step}"><span class="unit">${unit}</span></div>`;
}

function renderProps(){
  const box = document.getElementById('props');
  const c = byUid(state.sel);
  if (!c){
    box.innerHTML = `<div class="empty">Nothing selected. Click a chamber to edit it, or add one.</div>`;
    return;
  }
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
     <div class="btnrow">
       <button id="pDup">Duplicate</button>
       <button id="pDel" class="warn">Delete</button>
     </div>`;

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
  bind('pRef','ref', String); bind('pIX','intX'); bind('pIY','intY');
  bind('pW','wall'); bind('pX','x'); bind('pY','y'); bind('pR','rot');

  document.getElementById('pSq').onchange = e => {
    state.square = e.target.checked;
    if (state.square){ c.intY = c.intX; renderProps(); draw(); }
  };
  document.getElementById('pDup').onclick = () => {
    const n = makeChamber({...c, uid: uid(), ref: nextRef(), x: c.x + c.intX + 2*c.wall + 1000});
    state.chambers.push(n); select(n.uid);
  };
  document.getElementById('pDel').onclick = () => removeChamber(c.uid);
}

function removeChamber(u){
  state.chambers = state.chambers.filter(c => c.uid !== u);
  state.connections = state.connections.filter(c => c.a.mh !== u && c.b.mh !== u);
  state.sel = null; state.pending = null;
  renderProps(); renderConnections(); draw();
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
    intX: base ? base.intX : 1200,
    intY: base ? base.intY : 1200,
    wall: base ? base.wall : 150
  });
  state.chambers.push(c);
  select(c.uid);
};

const btnConnect = document.getElementById('btnConnect');
btnConnect.onclick = () => {
  state.mode = state.mode === 'connect' ? 'select' : 'connect';
  state.pending = null;
  btnConnect.classList.toggle('on', state.mode === 'connect');
  document.getElementById('rmode').textContent =
    state.mode === 'connect' ? 'connect mode — pick two internal faces' : '';
  draw();
};

document.getElementById('btnFit').onclick = () => fitView();

document.getElementById('snap').oninput = e => { state.snap = Math.max(0, Number(e.target.value)||0); };
document.getElementById('grid').onchange = e => { state.showGrid = e.target.checked; draw(); };
document.getElementById('dims').onchange = e => { state.showDims = e.target.checked; draw(); };

document.getElementById('btnExport').onclick = () => {
  const data = {
    units: 'mm',
    axes: '+X east, +Y north',
    chambers: state.chambers.map(({uid, ...rest}) => rest),
    connections: state.connections.map(cn => ({
      from: {ref: byUid(cn.a.mh)?.ref, face: cn.a.face},
      to:   {ref: byUid(cn.b.mh)?.ref, face: cn.b.face},
      internalFaceLength: Math.round(connLength(cn))
    }))
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'manhole-plan.json';
  a.click();
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
        return A && B ? {uid: uid(), a:{mh:A.uid, face:cn.from.face}, b:{mh:B.uid, face:cn.to.face}} : null;
      }).filter(Boolean);
      state.sel = null;
      renderProps(); renderConnections(); fitView();
    } catch (err){
      alert('That file is not a plan export. Expected JSON with a chambers array.');
    }
    e.target.value = '';
  };
  rd.readAsText(f);
};

document.getElementById('btnClear').onclick = () => {
  if (!state.chambers.length || confirm('Remove every chamber and connection?')){
    state.chambers = []; state.connections = []; state.sel = null; state.pending = null;
    renderProps(); renderConnections(); draw();
  }
};

document.addEventListener('keydown', e => {
  if (/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  const c = byUid(state.sel);
  if ((e.key === 'Delete' || e.key === 'Backspace') && c){ e.preventDefault(); removeChamber(c.uid); }
  else if (e.key === 'Escape'){ state.pending = null; select(null); }
  else if (e.key === 'f' || e.key === 'F') fitView();
  else if (e.key.startsWith('Arrow') && c){
    e.preventDefault();
    const d = (state.snap || 10) * (e.shiftKey ? 10 : 1);
    if (e.key === 'ArrowLeft') c.x -= d;
    if (e.key === 'ArrowRight') c.x += d;
    if (e.key === 'ArrowUp') c.y += d;
    if (e.key === 'ArrowDown') c.y -= d;
    renderProps(); draw();
  }
});

new ResizeObserver(() => draw()).observe(STAGE);

/* ==========================================================================
   START
   ========================================================================== */

state.chambers = [
  makeChamber({ref:'MH01', x:0,     y:0,    intX:1200, intY:1200, wall:150}),
  makeChamber({ref:'MH02', x:9000,  y:0,    intX:1500, intY:1500, wall:200}),
  makeChamber({ref:'MH03', x:17500, y:3800, intX:1200, intY:1200, wall:150, rot:30})
];
renderProps();
renderConnections();
fitView();
