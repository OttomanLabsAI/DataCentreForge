"""Read a Revit IFC 2x3 export of the fibre containment model and write the MV example for the tool:
every manhole, vault and pull box as a chamber family instance, and every
conduit bank that joins two of them as a run with its per-row counts."""
import json, math, sys
from collections import Counter, defaultdict
from ifcq import *
if len(sys.argv) != 3:
    sys.exit('usage: python3 extract_mv_example.py <model.ifc> <out.json>')
import os
SRC = os.path.basename(sys.argv[1]); OUT = sys.argv[2]
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
# ---------------- chambers
KIND = [('MV_Fibre', 'MV', 'MVF', 200), ('LV Typical', 'LVV', 'LVV', 250), ('DPB', 'DPB', 'DPB', 5)]
chambers = []
for e in ifc.bytype['IFCBUILDINGELEMENTPROXY'] + ifc.bytype['IFCDISTRIBUTIONCHAMBERELEMENT']:
    a = ifc.a(e); F = ifc.local(a[5]); p = to_internal(F[0]); ex = vec_internal(F[1]); ey = vec_internal(F[2])
    rot = math.degrees(math.atan2(ex[1], ex[0])); mir = (ex[0]*ey[1]-ex[1]*ey[0]) < 0
    pts = local_points(e); bb = [[min(q[i] for q in pts), max(q[i] for q in pts)] for i in range(3)]
    ot = a[4] or ''
    kind = next(k for k in KIND if k[0] in ot)
    chambers.append({'ent':e, 'id':int(a[7]), 'guid':a[0], 'kind':kind[1], 'prefix':kind[2], 'wall':kind[3], 'type':ot.split(':')[-1],
                     'family':ot.split(':')[0], 'p':p, 'rot':rot, 'mir':mir, 'bb':bb, 'ex':ex, 'ey':ey})
CH = {c['id']: c for c in chambers}
def local_of(c, q):
    d = [q[0]-c['p'][0], q[1]-c['p'][1]]; r = -c['rot']*math.pi/180; co, si = math.cos(r), math.sin(r)
    return [d[0]*co - d[1]*si, d[0]*si + d[1]*co, q[2]-c['p'][2]]
def local_vec(c, v):
    r = -c['rot']*math.pi/180; co, si = math.cos(r), math.sin(r); return [v[0]*co - v[1]*si, v[0]*si + v[1]*co, v[2]]
FACE_N = {'A':[0,1], 'B':[1,0], 'C':[0,-1], 'D':[-1,0]}
# ---------------- ports and chains
p2e = {}; eports = defaultdict(list)
for r in ifc.bytype['IFCRELCONNECTSPORTTOELEMENT']:
    ra = ifc.a(r); p2e[int(ra[4])] = int(ra[5]); eports[int(ra[5])].append(int(ra[4]))
conn = {}
for r in ifc.bytype['IFCRELCONNECTSPORTS']:
    ra = ifc.a(r); conn[int(ra[4])] = int(ra[5]); conn[int(ra[5])] = int(ra[4])
def port_geo(p):
    pa = ifc.a(p); PF = ifc.local(pa[5]); return to_internal(PF[0]), vec_internal(PF[3])
relevant = {e for e in ifc.bytype['IFCFLOWSEGMENT'] + ifc.bytype['IFCFLOWFITTING'] if 'Rectangular' not in (ifc.a(e)[4] or '')}
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
# join chains whose loose ends touch (the wall sleeves are not port-connected to the runs)
def match(port, prev_pt):
    pos, dz = port_geo(port); best = None
    for c in chambers:
        hx = c['bb'][0][1]; hy = c['bb'][1][1]; w = c['wall']; lq = local_of(c, pos); ld = local_vec(c, dz)
        if c['kind'] == 'DPB':
            if abs(lq[0]) <= hx + 200 and lq[1] >= c['bb'][1][0] - 200 and lq[1] <= hy + 200 and abs(dz[2]) > 0.7 and abs(lq[2]) < 1500:
                # rises into the box: the face is the one it approached through
                ap = local_vec(c, [pos[0]-prev_pt[0], pos[1]-prev_pt[1], 0]) if prev_pt else [0, -1, 0]
                f = max(FACE_N, key=lambda f: -(FACE_N[f][0]*ap[0] + FACE_N[f][1]*ap[1]))
                along = lq[1] if f in 'BD' else lq[0]
                if best is None or abs(lq[2]) < best[0]: best = (abs(lq[2]), c, f, lq, 0, along)
            continue
        for f, n in FACE_N.items():
            along = lq[1] if f in 'BD' else lq[0]; half_along = hy if f in 'BD' else hx
            outn = (lq[0]*n[0] + lq[1]*n[1]) - (hx if f in 'BD' else hy)
            if abs(along) > half_along + 50: continue
            if outn < -(w + 150) or outn > 400: continue
            if (ld[0]*n[0] + ld[1]*n[1]) > -0.5: continue
            score = abs(outn + w)
            if best is None or score < best[0]: best = (score, c, f, lq, outn, along)
    if not best: return None
    score, c, f, lq, outn, along = best
    return {'c':c, 'face':f, 'lq':lq, 'along':along, 'z':pos[2]}
def endpos(ch, w): return port_geo(ch['start'] if w == 'start' else ch['end'])[0]
def prev_of(ch, w):
    # the point before the end, to know the approach direction
    pts = ch['pts']
    if len(pts) < 2: return None
    seq = pts if w == 'end' else pts[::-1]
    for q in reversed(seq[:-1]):
        if math.hypot(q[0]-seq[-1][0], q[1]-seq[-1][1]) > 100: return q
    return seq[-2]
for ch in chains:
    ch['ma'] = match(ch['start'], prev_of(ch, 'start')); ch['mb'] = match(ch['end'], prev_of(ch, 'end'))
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
# the ordered 3D path of a run, from one of its ends to the other, through every joined chain
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
    # drop points that lie within tol of the line through their neighbours (chords of bends are kept)
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
    paths = []
    for r in members:
        first = r['ends'][0] if r['ka'] == endkey else r['ends'][1]
        paths.append(run_path(r, first))
    counts = {len(p) for p in paths}
    if len(counts) == 1 and len(members) > 1:
        n = len(paths[0]); avg = [[sum(p[i][j] for p in paths)/len(paths) for j in range(3)] for i in range(n)]
    else:
        # members differ in make-up: take them all resampled by chainage fraction and average
        n = max(len(p) for p in paths)*4 + 8
        rs = [resample(p, n) for p in paths]
        avg = [[sum(p[i][j] for p in rs)/len(rs) for j in range(3)] for i in range(n)]
    return simplify(avg), len(counts) == 1
both = [r for r in runs if all(e[2] for e in r['ends'])]
open_runs = [r for r in runs if not all(e[2] for e in r['ends'])]
print('runs', len(runs), 'both ends on a chamber', len(both), 'open', len(open_runs))
# ---------------- banks: one run in the tool per pair of faces
banks = defaultdict(list)
for r in both:
    (c1, w1, m1), (c2, w2, m2) = r['ends']
    ka = (m1['c']['id'], m1['face']); kb = (m2['c']['id'], m2['face'])
    r['ka'], r['kb'] = ka, kb
    key = (ka, kb) if ka <= kb else (kb, ka); banks[key].append(r)
# every conduit end at a chamber (including open runs) sets the chamber's conduit rows
rows_at = defaultdict(list)
for r in runs:
    for ch, w, m in r['ends']:
        if m: rows_at[m['c']['id']].append(m['z'])
ZP = 250
def rows_of(members, endkey):
    rows = defaultdict(list)
    for r in members:
        m = r['ends'][0][2] if r['ka'] == endkey else r['ends'][1][2]
        rows[round(m['z']/60)*60].append(m['along'])
    return [(z, sorted(rows[z])) for z in sorted(rows, reverse=True)]
# chamber records
def order_key(c): return (round(c['p'][0]/1000), round(c['p'][1]/1000))
for kind in ['MV', 'LVV', 'DPB']:
    for i, c in enumerate(sorted([c for c in chambers if c['kind'] == kind], key=order_key), 1):
        c['mark'] = '%s-%02d' % (c['prefix'], i)
for c in chambers:
    zs = rows_at.get(c['id'], [])
    lid = c['p'][2] + (c['bb'][2][1] if c['kind'] != 'DPB' else c['bb'][2][1])
    top = max(zs) if zs else lid - 1000
    c['z0'] = round(top)
    c['lid'] = round(lid)
    c['base'] = round(c['p'][2] + c['bb'][2][0]) if c['kind'] != 'DPB' else round(c['p'][2] - 1200)
    if c['kind'] == 'DPB': c['z0'] = round(c['p'][2] - 800)      # a pull box stands on the ground; its conduits arrive below it
families = []
for kind, famname in [('MV', 'MAN_MAnhole Vault'), ('LVV', 'GEM_vault1'), ('DPB', 'PEC')]:
    cs = [c for c in chambers if c['kind'] == kind]
    c0 = cs[0]; hx = c0['bb'][0][1]; hy = c0['bb'][1][1]; w = c0['wall']
    y0, y1 = c0['bb'][1][0], c0['bb'][1][1]; x0, x1 = c0['bb'][0][0], c0['bb'][0][1]
    planes = [
        {'name':'a1', 'axis':'a', 'normal':[1,0,0], 'offset_mm':round(x0,1)}, {'name':'a2', 'axis':'a', 'normal':[1,0,0], 'offset_mm':round(x0 + w,1)},
        {'name':'a6', 'axis':'a', 'normal':[1,0,0], 'offset_mm':round(x1 - w,1)}, {'name':'a7', 'axis':'a', 'normal':[1,0,0], 'offset_mm':round(x1,1)},
        {'name':'b1', 'axis':'b', 'normal':[0,1,0], 'offset_mm':round(y0,1)}, {'name':'b2', 'axis':'b', 'normal':[0,1,0], 'offset_mm':round(y0 + w,1)},
        {'name':'b6', 'axis':'b', 'normal':[0,1,0], 'offset_mm':round(y1 - w,1)}, {'name':'b7', 'axis':'b', 'normal':[0,1,0], 'offset_mm':round(y1,1)},
        {'name':'z1', 'axis':'z', 'normal':[0,0,1], 'offset_mm':round(c0['bb'][2][0],1)}, {'name':'z2', 'axis':'z', 'normal':[0,0,1], 'offset_mm':round(c0['bb'][2][1],1)}]
    insts = []
    for c in sorted(cs, key=lambda c: c['mark']):
        insts.append({'id':c['id'], 'unique_id':c['guid'], 'mark':c['mark'], 'type':c['type'],
                      'origin_mm':[round(v,2) for v in c['p']], 'rotation_deg':round(c['rot'],3),
                      'family_x_axis':[round(v,6) for v in c['ex']], 'family_y_axis':[round(v,6) for v in c['ey']], 'mirrored':c['mir'],
                      'lid_mm':c['lid'], 'base_mm':c['base'], 'z0_mm':c['z0']})
    families.append({'family':famname, 'type':c0['type'], 'spacing_mm':{'lateral':ZP if kind != 'LVV' else 210, 'vertical':ZP}, 'planes':planes, 'instances':insts})
# runs
out_runs = []
od_of = lambda r: round(r*2)
for key, members in sorted(banks.items(), key=lambda kv: (CH[kv[0][0][0]]['mark'], kv[0][0][1], CH[kv[0][1][0]]['mark'])):
    a, b = key; ca, cb = CH[a[0]], CH[b[0]]
    ra = rows_of(members, a); rb = rows_of(members, b)
    per_row = [len(x[1]) for x in ra]
    align = None
    if len(set(per_row)) > 1:
        # which side the short rows pack to, seen along the face tangent at end a (left = lower along-coordinate)
        longest = max(ra, key=lambda x: len(x[1]))[1]
        short = min(ra, key=lambda x: len(x[1]))[1]
        align = 'left' if abs(short[0] - longest[0]) < 30 else 'right'
    level = max(0, round((ca['z0'] - ra[0][0]) / ZP))
    od = Counter(od_of(r['r']) for r in members).most_common(1)[0][0]
    zs = [x[0] for x in ra]
    row_pitch = round(sum(zs[i] - zs[i+1] for i in range(len(zs)-1)) / max(1, len(zs)-1)) if len(zs) > 1 else ZP
    lats = [x[1] for x in ra if len(x[1]) > 1 and x[1][-1] - x[1][0] > 1]      # rows that really spread across the face
    col_pitch = round(sum((r[-1]-r[0])/(len(r)-1) for r in lats) / len(lats)) if lats else ZP
    path, uniform = bank_path(members, a)
    out_runs.append({'from':{'id':a[0], 'face':a[1]}, 'to':{'id':b[0], 'face':b[1]}, 'perRow':per_row, 'align':align, 'level':level,
                     'encased':True, 'enc_mm':100,           # the banks are concrete-encased: the box is modelled in with the run
                     'path_mm':[[round(v, 1) for v in q] for q in path],
                     'od_mm':od, 'pitch_mm':col_pitch, 'row_pitch_mm':row_pitch, 'top_mm':[round(ra[0][0]), round(rb[0][0])],
                     'length_mm':round(sum(r['L'] for r in members)/len(members)), 'bends':Counter(r['bends'] for r in members).most_common(1)[0][0],
                     'ifc_ids':sorted(set(i for r in members for i in r['ids']))})
open_note = Counter(od_of(r['r']) for r in open_runs)
doc = {
  'units':'mm', 'source':SRC, 'document':SRC,
  'note':('The fibre containment model of the same site, read from its IFC: %d manholes, %d vaults and %d pull boxes at their true positions, sizes and depths, '
          'and the %d conduit banks that join two of them, each with the number of conduits in every row and its centreline as modelled. %d conduit runs leave the model with one end in the open and are not listed.'
          % (sum(1 for c in chambers if c['kind']=='MV'), sum(1 for c in chambers if c['kind']=='LVV'), sum(1 for c in chambers if c['kind']=='DPB'), len(out_runs), len(open_runs))),
  'families':families, 'runs':out_runs}
json.dump(doc, open(OUT, 'w'), indent=1)
print('chambers', Counter(c['kind'] for c in chambers), 'runs written', len(out_runs), 'open runs', len(open_runs), 'by OD', open_note)
print('run patterns', Counter(tuple(r['perRow']) for r in out_runs).most_common(), 'ODs', Counter(r['od_mm'] for r in out_runs), 'levels', Counter(r['level'] for r in out_runs))
print('pitches: across', Counter(r['pitch_mm'] for r in out_runs).most_common(6), 'down', Counter(r['row_pitch_mm'] for r in out_runs).most_common(6))
print('path vertices', Counter(len(r['path_mm']) for r in out_runs).most_common(8), 'uniform member make-up', sum(1 for k, v in banks.items() if bank_path(v, k[0])[1]), 'of', len(banks))
def plen(p): return sum(math.dist(p[i], p[i-1]) for i in range(1, len(p)))
print('path length vs members', [(round(plen(r['path_mm'])/1000, 1), round(r['length_mm']/1000, 1)) for r in out_runs[:8]])
print('kinds joined', Counter((CH[r['from']['id']]['kind'], CH[r['to']['id']]['kind']) for r in out_runs))
print('z0 vs lid (MV)', [(c['mark'], c['lid'], c['z0'], c['base']) for c in chambers if c['kind']=='MV'][:6])
print('DPB', [(c['mark'], c['lid'], c['z0'], c['base']) for c in chambers if c['kind']=='DPB'])
print('written', OUT, os.path.getsize(OUT), 'bytes')
