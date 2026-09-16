"""Read the Revit IFC 2x3 export of the LV power model and add its conduits to the
LV example: every bank of conduits that joins two of the model's chambers becomes a
run between two faces, with its per-row counts, its centreline and the depth the
chamber carries it at. The manholes themselves stay exactly as the Revit export
placed them — this only adds what the IFC knows and the export did not."""
import json, math, os, sys
from collections import Counter, defaultdict
from ifcq import *

if len(sys.argv) != 3:
    sys.exit('usage: python3 extract_lv_runs.py <model.ifc> <lv-manholes.json>')
SRC = os.path.basename(sys.argv[1]); OUT = sys.argv[2]
FAMILY = 'MV Chamber'          # the chamber family of the LV model, as the IFC names it
WALL = 100                     # its wall, for deciding which face a conduit arrives at
ZP = 240                       # the level pitch: the centres the model stacks its banks on
LAT = 210                      # the centres it lays them on across a face
ifc = IFC(sys.argv[1])
site = ifc.bytype['IFCSITE'][0]; SF = ifc.local(ifc.a(site)[5]); O, X, Y, Z = SF
def to_internal(p): d = sub(p, O); return [dot(d, X), dot(d, Y), dot(d, Z)]
def vec_internal(v): return [dot(v, X), dot(v, Y), dot(v, Z)]

def brep_points(item):
    t = ifc.t(item); pts = []
    if t == 'IFCMAPPEDITEM':
        rmap, op = ifc.a(item); origin, rep = ifc.a(rmap); MF = ifc.axis2(origin)
        oa = ifc.a(op); ax1 = ifc.dir(oa[0], [1,0,0]); ax2 = ifc.dir(oa[1], [0,1,0]); loc = ifc.pt(oa[2]); sc = oa[3] if oa[3] is not None else 1.0
        ax3 = ifc.dir(oa[4], [0,0,1]) if len(oa) > 4 else [0,0,1]
        TF = (loc, mul(ax1, sc), mul(ax2, sc), mul(ax3, sc))
        for it in ifc.a(rep)[3]:
            for p in brep_points(it): pts.append(apply(TF, apply(MF, p)))
        return pts
    if t == 'IFCFACETEDBREP':
        for f in ifc.a(ifc.a(item)[0])[0]:
            for b in ifc.a(f)[0]:
                for p in ifc.a(ifc.a(b)[0])[0]: pts.append(ifc.pt(p))
        return pts
    if t == 'IFCEXTRUDEDAREASOLID':
        prof, pos, d, depth = ifc.a(item); PF = ifc.axis2(pos); dv = ifc.dir(d, [0,0,1]); pa = ifc.a(prof)
        if ifc.t(prof) == 'IFCRECTANGLEPROFILEDEF':
            P2 = ifc.axis2d(pa[2]); hx, hy = pa[3]/2, pa[4]/2; base = [apply(P2, [sx*hx, sy*hy, 0]) for sx in (-1,1) for sy in (-1,1)]
        elif ifc.t(prof) == 'IFCCIRCLEPROFILEDEF':
            P2 = ifc.axis2d(pa[2]); r = pa[3]; base = [apply(P2, [r*math.cos(a), r*math.sin(a), 0]) for a in (0, math.pi/2, math.pi, 3*math.pi/2)]
        else: base = []
        for p in base: pts.append(apply(PF, p)); pts.append(apply(PF, add(p, mul(dv, depth))))
    return pts
def local_points(e):
    pts = []
    for sr in ifc.a(ifc.a(e)[6])[2]:
        sa = ifc.a(sr)
        if sa[1] == 'Body':
            for it in sa[3]: pts += brep_points(it)
    return pts

# ---------------- chambers: the model's own, by Revit id
chambers = []
for e in ifc.bytype['IFCBUILDINGELEMENTPROXY'] + ifc.bytype['IFCDISTRIBUTIONCHAMBERELEMENT']:
    a = ifc.a(e)
    if FAMILY not in (a[4] or '') or not a[7]: continue
    pts = local_points(e)
    if not pts: continue
    F = ifc.local(a[5]); p = to_internal(F[0]); ex = vec_internal(F[1]); ey = vec_internal(F[2])
    bb = [[min(q[i] for q in pts), max(q[i] for q in pts)] for i in range(3)]
    chambers.append({'ent':e, 'id':int(a[7]), 'guid':a[0], 'p':p, 'rot':math.degrees(math.atan2(ex[1], ex[0])), 'bb':bb})
CH = {c['id']: c for c in chambers}
def local_of(c, q):
    d = [q[0]-c['p'][0], q[1]-c['p'][1]]; r = -c['rot']*math.pi/180; co, si = math.cos(r), math.sin(r)
    return [d[0]*co - d[1]*si, d[0]*si + d[1]*co, q[2]-c['p'][2]]
def local_vec(c, v):
    r = -c['rot']*math.pi/180; co, si = math.cos(r), math.sin(r); return [v[0]*co - v[1]*si, v[0]*si + v[1]*co, v[2]]
FACE_N = {'A':[0,1], 'B':[1,0], 'C':[0,-1], 'D':[-1,0]}

# ---------------- conduits: ports chained into runs, runs joined where their ends touch
p2e = {}; eports = defaultdict(list)
for r in ifc.bytype['IFCRELCONNECTSPORTTOELEMENT']:
    ra = ifc.a(r); p2e[int(ra[4])] = int(ra[5]); eports[int(ra[5])].append(int(ra[4]))
conn = {}
for r in ifc.bytype['IFCRELCONNECTSPORTS']:
    ra = ifc.a(r); conn[int(ra[4])] = int(ra[5]); conn[int(ra[5])] = int(ra[4])
def port_geo(p):
    pa = ifc.a(p); PF = ifc.local(pa[5]); return to_internal(PF[0]), vec_internal(PF[3])
relevant = set(ifc.bytype['IFCFLOWSEGMENT'] + ifc.bytype['IFCFLOWFITTING'])
def seg_info(e):
    for sr in ifc.a(ifc.a(e)[6])[2]:
        for it in ifc.a(sr)[3]:
            if ifc.t(it) == 'IFCEXTRUDEDAREASOLID':
                prof, pos, d, depth = ifc.a(it); pa = ifc.a(prof)
                return (pa[3] if ifc.t(prof) == 'IFCCIRCLEPROFILEDEF' else None), depth
    return None, None
visited = set(); chains = []
for p0 in [p for p in p2e if p not in conn and p2e[p] in relevant]:
    if p2e[p0] in visited: continue
    cur = p0; els = []; pts = [port_geo(p0)[0]]
    while True:
        el = p2e[cur]
        if el in visited: break
        visited.add(el); els.append(el)
        others = [q for q in eports[el] if q != cur]
        if not others: end = cur; break
        oth = others[0]; pts.append(port_geo(oth)[0]); nxt = conn.get(oth)
        if nxt is None: end = oth; break
        cur = nxt
    r = None; L = 0.0
    for el in els:
        if ifc.t(el) == 'IFCFLOWSEGMENT':
            rr, dd = seg_info(el); r = rr or r; L += dd or 0
    chains.append({'start':p0, 'end':end, 'els':els, 'pts':pts, 'r':r, 'L':L})

def match(port, prev_pt):
    """The chamber face a conduit end arrives at, if any: inside the wall, aimed at it, within the face."""
    pos, dz = port_geo(port); best = None
    for c in chambers:
        hx = c['bb'][0][1]; hy = c['bb'][1][1]; lq = local_of(c, pos); ld = local_vec(c, dz)
        for f, n in FACE_N.items():
            along = lq[1] if f in 'BD' else lq[0]; half_along = hy if f in 'BD' else hx
            outn = (lq[0]*n[0] + lq[1]*n[1]) - (hx if f in 'BD' else hy)
            if abs(along) > half_along + 50: continue
            if outn < -(WALL + 150) or outn > 400: continue
            if (ld[0]*n[0] + ld[1]*n[1]) > -0.5: continue
            score = abs(outn + WALL)
            if best is None or score < best[0]: best = (score, c, f, lq, outn, along)
    if not best: return None
    score, c, f, lq, outn, along = best
    return {'c':c, 'face':f, 'lq':lq, 'along':along, 'z':pos[2]}
def endpos(ch, w): return port_geo(ch['start'] if w == 'start' else ch['end'])[0]
def prev_of(ch, w):
    pts = ch['pts']
    if len(pts) < 2: return None
    seq = pts if w == 'end' else pts[::-1]
    for q in reversed(seq[:-1]):
        if math.hypot(q[0]-seq[-1][0], q[1]-seq[-1][1]) > 100: return q
    return seq[-2]
for ch in chains:
    ch['ma'] = match(ch['start'], prev_of(ch, 'start')); ch['mb'] = match(ch['end'], prev_of(ch, 'end'))
# the wall sleeves are not port-connected to the runs: join loose ends that touch
loose = [(ch, w) for ch in chains for w in ('start', 'end') if (ch['ma'] if w == 'start' else ch['mb']) is None]
used = set(); pairs = []
for ch, w in loose:
    if (id(ch), w) in used: continue
    p = endpos(ch, w); best = None
    for ch2, w2 in loose:
        if ch2 is ch or (id(ch2), w2) in used: continue
        d = math.dist(p, endpos(ch2, w2))
        if best is None or d < best[0]: best = (d, ch2, w2)
    if best and best[0] < 60:
        used.add((id(ch), w)); used.add((id(best[1]), best[2])); pairs.append((ch, w, best[1], best[2]))
parent = {id(ch): ch for ch in chains}
def find(ch):
    while parent[id(ch)] is not ch: ch = parent[id(ch)]
    return ch
for ch, w, ch2, w2 in pairs:
    a, b = find(ch), find(ch2)
    if a is not b: parent[id(a)] = b
groups = defaultdict(list)
for ch in chains: groups[id(find(ch))].append(ch)
runs = []
for g in groups.values():
    ends = []
    for ch in g:
        for w, m in (('start', ch['ma']), ('end', ch['mb'])):
            if not any((ch is c1 and w == w1) or (ch is c2 and w == w2) for c1, w1, c2, w2 in pairs): ends.append((ch, w, m))
    if len(ends) != 2: continue
    runs.append({'parts':g, 'ends':ends, 'L':sum(ch['L'] for ch in g), 'r':max((ch['r'] or 0) for ch in g),
                 'bends':sum(1 for ch in g for e in ch['els'] if ifc.t(e) == 'IFCFLOWFITTING'),
                 'ids':[int(ifc.a(e)[7]) for ch in g for e in ch['els'] if ifc.a(e)[7]]})

JOIN = {}
for ch, w, ch2, w2 in pairs: JOIN[(id(ch), w)] = (ch2, w2); JOIN[(id(ch2), w2)] = (ch, w)
def run_path(r, first_end):
    ch, w, m = first_end; out = []
    while True:
        pts = ch['pts'] if w == 'start' else ch['pts'][::-1]
        if out and math.dist(out[-1], pts[0]) < 1: pts = pts[1:]
        out += pts
        other = 'end' if w == 'start' else 'start'
        nxt = JOIN.get((id(ch), other))
        if not nxt: return out
        ch, w = nxt
def resample(path, n):
    cum = [0.0]
    for i in range(1, len(path)): cum.append(cum[-1] + math.dist(path[i], path[i-1]))
    L = cum[-1] or 1.0; out = []
    for k in range(n):
        s = L*k/(n-1); i = 1
        while i < len(cum)-1 and cum[i] < s: i += 1
        t = (s - cum[i-1]) / max(1e-9, cum[i]-cum[i-1])
        out.append([path[i-1][j] + (path[i][j]-path[i-1][j])*t for j in range(3)])
    return out
def simplify(path, tol=8.0):
    if len(path) < 3: return path
    keep = [path[0]]
    for i in range(1, len(path)-1):
        a, b, p = keep[-1], path[i+1], path[i]
        ab = [b[j]-a[j] for j in range(3)]; ap = [p[j]-a[j] for j in range(3)]
        L2 = sum(v*v for v in ab) or 1e-9; t = max(0.0, min(1.0, sum(ab[j]*ap[j] for j in range(3))/L2))
        d = math.dist(p, [a[j] + ab[j]*t for j in range(3)])
        if d > tol or math.dist(p, keep[-1]) > 20000: keep.append(p)
    keep.append(path[-1]); return keep
def bank_path(members, endkey):
    """One centreline for the whole bank: its members averaged, from the given end."""
    paths = []
    for r in members:
        first = r['ends'][0] if r['ka'] == endkey else r['ends'][1]
        paths.append(run_path(r, first))
    counts = {len(p) for p in paths}
    if len(counts) == 1 and len(members) > 1:
        n = len(paths[0]); avg = [[sum(p[i][j] for p in paths)/len(paths) for j in range(3)] for i in range(n)]
    else:
        n = max(len(p) for p in paths)*4 + 8
        rs = [resample(p, n) for p in paths]
        avg = [[sum(p[i][j] for p in rs)/len(rs) for j in range(3)] for i in range(n)]
    return simplify(avg)

both = [r for r in runs if all(e[2] for e in r['ends'])]
open_runs = [r for r in runs if not all(e[2] for e in r['ends'])]

# ---------------- banks: one run in the tool per pair of faces
banks = defaultdict(list)
for r in both:
    (c1, w1, m1), (c2, w2, m2) = r['ends']
    ka = (m1['c']['id'], m1['face']); kb = (m2['c']['id'], m2['face'])
    r['ka'], r['kb'] = ka, kb
    key = (ka, kb) if ka <= kb else (kb, ka); banks[key].append(r)
rows_at = defaultdict(list)
for r in runs:
    for ch, w, m in r['ends']:
        if m: rows_at[m['c']['id']].append(m['z'])
def rows_of(members, endkey):
    rows = defaultdict(list)
    for r in members:
        m = r['ends'][0][2] if r['ka'] == endkey else r['ends'][1][2]
        rows[round(m['z']/60)*60].append(m['along'])
    return [(z, sorted(rows[z])) for z in sorted(rows, reverse=True)]
for c in chambers:
    zs = rows_at.get(c['id'], [])
    c['lid'] = round(c['p'][2] + c['bb'][2][1]); c['base'] = round(c['p'][2] + c['bb'][2][0])
    c['z0'] = round(max(zs)) if zs else c['lid'] - 1000

out_runs = []
for key, members in sorted(banks.items(), key=lambda kv: (kv[0][0][0], kv[0][0][1], kv[0][1][0])):
    a, b = key; ca, cb = CH[a[0]], CH[b[0]]
    ra = rows_of(members, a); rb = rows_of(members, b)
    per_row = [len(x[1]) for x in ra]
    align = None
    if len(set(per_row)) > 1:
        longest = max(ra, key=lambda x: len(x[1]))[1]; short = min(ra, key=lambda x: len(x[1]))[1]
        align = 'left' if abs(short[0] - longest[0]) < 30 else 'right'
    level = max(0, round((ca['z0'] - ra[0][0]) / ZP))
    od = Counter(round(r['r']*2) for r in members).most_common(1)[0][0]
    zs = [x[0] for x in ra]
    row_pitch = round(sum(zs[i] - zs[i+1] for i in range(len(zs)-1)) / max(1, len(zs)-1)) if len(zs) > 1 else ZP
    lats = [x[1] for x in ra if len(x[1]) > 1 and x[1][-1] - x[1][0] > 1]
    col_pitch = round(sum((r[-1]-r[0])/(len(r)-1) for r in lats) / len(lats)) if lats else LAT
    out_runs.append({'from':{'id':a[0], 'face':a[1]}, 'to':{'id':b[0], 'face':b[1]}, 'perRow':per_row, 'align':align, 'level':level,
                     'path_mm':[[round(v, 1) for v in q] for q in bank_path(members, a)],
                     'od_mm':od, 'pitch_mm':col_pitch, 'row_pitch_mm':row_pitch, 'top_mm':[round(ra[0][0]), round(rb[0][0])],
                     'length_mm':round(sum(r['L'] for r in members)/len(members)), 'bends':Counter(r['bends'] for r in members).most_common(1)[0][0],
                     'ifc_ids':sorted(set(i for r in members for i in r['ids']))})

# ---------------- merge into the example: the Revit export's manholes, with what the IFC adds
doc = json.load(open(OUT))
known = {i['id']: i for f in doc['families'] for i in f['instances']}
for f in doc['families']:
    f['spacing_mm'] = {'lateral': LAT, 'vertical': ZP}
depths = 0
for c in chambers:
    inst = known.get(c['id'])
    if not inst: continue
    inst['lid_mm'] = c['lid']; inst['base_mm'] = c['base']; inst['z0_mm'] = c['z0']; depths += 1
out_runs = [r for r in out_runs if r['from']['id'] in known and r['to']['id'] in known]
doc['runs'] = out_runs
doc['runs_source'] = SRC
doc['note'] = ('Example placements from a live data-centre model: the %d manholes of the MV Chamber family at their true positions and rotations. '
               'The family in that model carries only its depth planes, so the side planes here are the DCBuild family\'s. '
               'Its conduits come from the model\'s own IFC: %d banks joining two chambers, each with the number of conduits in every row and its centreline as modelled, '
               'and the %d chambers the IFC covers carry their true lid, base and conduit depths. %d conduit runs leave the model with one end in the open and are not listed.'
               % (len(known), len(out_runs), depths, len(open_runs)))
json.dump(doc, open(OUT, 'w'), indent=1)
print('chambers in the IFC', len(chambers), 'of', len(known), 'in the example · depths written', depths)
print('conduit chains', len(runs), 'both ends on a chamber', len(both), 'open', len(open_runs), 'banks written', len(out_runs))
print('patterns', Counter(tuple(r['perRow']) for r in out_runs).most_common(8))
print('ODs', Counter(r['od_mm'] for r in out_runs), 'levels', Counter(r['level'] for r in out_runs))
print('pitches: across', Counter(r['pitch_mm'] for r in out_runs).most_common(6), 'down', Counter(r['row_pitch_mm'] for r in out_runs).most_common(6))
print('path vertices', Counter(len(r['path_mm']) for r in out_runs).most_common(6))
print('written', OUT, os.path.getsize(OUT), 'bytes')
