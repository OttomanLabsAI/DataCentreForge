import re, math, sys, json
class R(int): pass
class E(str): pass
NUM = re.compile(r'[-+]?(\d+\.?\d*|\.\d+)(E[-+]?\d+)?')
TYPED = re.compile(r'[A-Z][A-Z0-9_]*\(')
def parse_args(s):
    i = 0; n = len(s)
    def val():
        nonlocal i
        while i < n and s[i] == ' ': i += 1
        c = s[i]
        if c == '(':
            i += 1; lst = []
            while True:
                while s[i] == ' ': i += 1
                if s[i] == ')': i += 1; return lst
                lst.append(val())
                while s[i] == ' ': i += 1
                if s[i] == ',': i += 1
        if c == "'":
            j = i + 1; out = []
            while True:
                if s[j] == "'":
                    if j + 1 < n and s[j+1] == "'": out.append("'"); j += 2; continue
                    break
                out.append(s[j]); j += 1
            i = j + 1; return ''.join(out)
        if c == '#':
            j = i + 1
            while j < n and s[j].isdigit(): j += 1
            v = R(int(s[i+1:j])); i = j; return v
        if c == '$': i += 1; return None
        if c == '*': i += 1; return E('*')
        if c == '.':
            j = s.index('.', i + 1); v = E(s[i+1:j]); i = j + 1; return v
        m = TYPED.match(s, i)
        if m:
            i = m.end(); v = val()
            while s[i] == ' ': i += 1
            assert s[i] == ')', s[i:i+20]; i += 1; return v
        m = NUM.match(s, i)
        if m: i = m.end(); return float(m.group(0))
        raise ValueError('bad token at %d: %r' % (i, s[i:i+30]))
    out = []
    while i < n:
        while i < n and s[i] == ' ': i += 1
        if i >= n: break
        out.append(val())
        while i < n and s[i] == ' ': i += 1
        if i < n and s[i] == ',': i += 1
    return out
class IFC:
    def __init__(self, path):
        self.raw = {}; self.types = {}; self.cache = {}
        data = open(path, encoding='latin-1').read()
        for m in re.finditer(r'^#(\d+)=([A-Z0-9_]+)\((.*)\);\s*$', data, re.M):
            eid = int(m.group(1)); self.raw[eid] = m.group(3); self.types[eid] = m.group(2)
        self.bytype = {}
        for eid, t in self.types.items(): self.bytype.setdefault(t, []).append(eid)
    def a(self, eid):
        if eid not in self.cache: self.cache[eid] = parse_args(self.raw[eid])
        return self.cache[eid]
    def t(self, eid): return self.types[eid]
    # geometry helpers
    def dir(self, eid, default):
        if eid is None: return default
        v = self.a(eid)[0]; v = list(v) + [0.0] * (3 - len(v)); return v
    def pt(self, eid):
        v = self.a(eid)[0]; return list(v) + [0.0] * (3 - len(v))
    def axis2(self, eid):
        """IFCAXIS2PLACEMENT3D -> (origin, X, Y, Z)"""
        loc, axis, refd = (self.a(eid) + [None, None])[:3]
        O = self.pt(loc); Z = self.dir(axis, [0,0,1]); X0 = self.dir(refd, [1,0,0])
        Z = norm(Z); X = norm(sub(X0, mul(Z, dot(X0, Z)))); Y = cross(Z, X)
        return (O, X, Y, Z)
    def axis2d(self, eid):
        loc, refd = (self.a(eid) + [None])[:2]
        O = self.pt(loc); X = norm(self.dir(refd, [1,0,0])); Y = [-X[1], X[0], 0.0]
        return (O, X, Y, [0,0,1])
    def local(self, eid):
        """IFCLOCALPLACEMENT -> world frame (origin, X, Y, Z) composing PlacementRelTo"""
        key = ('L', eid)
        if key in self.cache: return self.cache[key]
        rel, rp = self.a(eid)[:2]
        F = self.axis2(rp)
        if rel is not None: F = compose(self.local(rel), F)
        self.cache[key] = F; return F
def norm(v):
    l = math.sqrt(sum(x*x for x in v)) or 1.0; return [x/l for x in v]
def sub(a, b): return [a[i]-b[i] for i in range(3)]
def add(a, b): return [a[i]+b[i] for i in range(3)]
def mul(a, s): return [x*s for x in a]
def dot(a, b): return sum(a[i]*b[i] for i in range(3))
def cross(a, b): return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
def apply(F, p):
    O, X, Y, Z = F; return [O[i] + p[0]*X[i] + p[1]*Y[i] + p[2]*Z[i] for i in range(3)]
def applyv(F, v):
    O, X, Y, Z = F; return [v[0]*X[i] + v[1]*Y[i] + v[2]*Z[i] for i in range(3)]
def compose(P, F):
    """frame F expressed in frame P -> world frame"""
    O, X, Y, Z = F
    return (apply(P, O), applyv(P, X), applyv(P, Y), applyv(P, Z))
def psets(ifc):
    """element id -> {psetName: {prop: value}}"""
    out = {}
    for rid in ifc.bytype.get('IFCRELDEFINESBYPROPERTIES', []):
        a = ifc.a(rid); objs = a[4]; pdef = a[5]
        if ifc.t(pdef) != 'IFCPROPERTYSET': continue
        pa = ifc.a(pdef); name = pa[2]; props = {}
        for pid in pa[4]:
            if ifc.t(pid) == 'IFCPROPERTYSINGLEVALUE':
                q = ifc.a(pid); props[q[0]] = q[2]
        for o in objs: out.setdefault(int(o), {})[name] = props
    return out
def typeof(ifc):
    out = {}
    for rid in ifc.bytype.get('IFCRELDEFINESBYTYPE', []):
        a = ifc.a(rid)
        for o in a[4]: out[int(o)] = int(a[5])
    return out
