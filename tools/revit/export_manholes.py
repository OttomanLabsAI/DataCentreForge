# -*- coding: utf-8 -*-
"""Export manhole reference planes from Revit to JSON (millimetres).

Works in Revit 2018 through 2026 (pyRevit, RevitPythonShell, or a Dynamo
Python node — IronPython 2.7 and CPython 3 alike).

Run from pyRevit or RevitPythonShell:
  - inside the FAMILY document: writes the family's named planes
  - inside a PROJECT: writes every placed instance of any family that carries
    the a/b/z plane convention, with each instance's origin and rotation, plus
    the family's planes in family coordinates. The Yes/No parameters
    obstacle_around, obstacle_over, obstacle_under (the "obstable_" spelling is
    accepted too) on a manhole are written as its "params": the avoidance
    methods allowed to the runs leaving it, applied to whatever they meet. Any
    other instance carrying those parameters is exported as an OBSTACLE: its
    own bounding box in family coordinates with its placement and those flags

Planes exported (by name):   a1..a7   b1..b7   z1..z6
                             a_conduit_boundary_1/2  b_conduit_boundary_1/2
                             z_conduit_boundary_1/2
Every instance carries its element id and unique id, and the file names its
document, so a later export of the same model refreshes the drawing in place.
Output: <model name>-manholes.json next to the model.
"""
import json, math, os, re
from Autodesk.Revit.DB import (FilteredElementCollector, ReferencePlane, FamilyInstance,
                               BuiltInParameter, UnitUtils, Options, GeometryInstance, Transform)
try:                                   # Revit 2021+
    from Autodesk.Revit.DB import UnitTypeId
    def to_mm(v): return round(UnitUtils.ConvertFromInternalUnits(v, UnitTypeId.Millimeters), 2)
except ImportError:                    # Revit 2020 and earlier
    from Autodesk.Revit.DB import DisplayUnitType
    def to_mm(v): return round(UnitUtils.ConvertFromInternalUnits(v, DisplayUnitType.DUT_MILLIMETERS), 2)

try:                                   # pyRevit / RevitPythonShell
    doc = __revit__.ActiveUIDocument.Document
except NameError:                      # Dynamo Python node
    import clr
    clr.AddReference('RevitServices')
    from RevitServices.Persistence import DocumentManager
    doc = DocumentManager.Instance.CurrentDBDocument


def eid(element_id):
    """Integer id across API generations (Value from 2024, IntegerValue before)."""
    v = getattr(element_id, 'Value', None)
    return int(v) if v is not None else element_id.IntegerValue


NAME_RE = re.compile(r'^(?:[abz]\d+|[abz]_conduit_boundary_\d+)$', re.I)


def plane_records(famdoc):
    """Every named a/b/z plane in family coordinates."""
    out = []
    for rp in FilteredElementCollector(famdoc).OfClass(ReferencePlane):
        name = rp.Name
        if not name or not NAME_RE.match(name):
            continue
        try:
            pl = rp.GetPlane(); o, n = pl.Origin, pl.Normal
        except AttributeError:         # older API
            o, n = rp.BubbleEnd, rp.Normal
        # signed distance of the plane from the family origin, along its own normal
        offset = o.X * n.X + o.Y * n.Y + o.Z * n.Z
        out.append({
            'name': name,
            'axis': name[0].lower(),
            'normal': [round(n.X, 6), round(n.Y, 6), round(n.Z, 6)],
            'offset_mm': to_mm(offset),
            'origin_mm': [to_mm(o.X), to_mm(o.Y), to_mm(o.Z)],
        })
    return sorted(out, key=lambda r: (r['axis'], r['name']))


def instance_record(inst):
    t = inst.GetTransform()
    mark = inst.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)
    return {
        'id': eid(inst.Id),
        'unique_id': inst.UniqueId,
        'mark': mark.AsString() if mark and mark.HasValue else None,
        'type': inst.Symbol.Name,
        'origin_mm': [to_mm(t.Origin.X), to_mm(t.Origin.Y), to_mm(t.Origin.Z)],
        'family_x_axis': [round(t.BasisX.X, 6), round(t.BasisX.Y, 6), round(t.BasisX.Z, 6)],
        'family_y_axis': [round(t.BasisY.X, 6), round(t.BasisY.Y, 6), round(t.BasisY.Z, 6)],
        'rotation_deg': round(math.degrees(math.atan2(t.BasisX.Y, t.BasisX.X)), 3),
        'mirrored': inst.Mirrored,
    }


# obstacle flags: instance parameter first, then the type's; missing = allowed
FLAG_NAMES = {'around': ('obstacle_around', 'obstable_around'),
              'over':   ('obstacle_over',   'obstable_over'),
              'under':  ('obstacle_under',  'obstable_under')}


def obstacle_flags(inst):
    """{'around': bool, 'over': bool, 'under': bool} for an element carrying any
    of the obstacle parameters, or None when it carries none."""
    flags, found = {}, False
    for key, names in FLAG_NAMES.items():
        for holder in (inst, inst.Symbol):
            p = None
            for nm in names:
                p = holder.LookupParameter(nm)
                if p is not None:
                    break
            if p is not None:
                found = True
                flags[key] = (p.AsInteger() == 1) if p.HasValue else True
                break
        flags.setdefault(key, True)
    return flags if found else None


def local_bounds(inst):
    """((min, max), transform): the instance's own geometry bounded in family
    coordinates, with the transform placing it in the model. None when the
    element has no instanced geometry."""
    ge = inst.get_Geometry(Options())
    if ge is None:
        return None
    lo, hi, t = [1e30] * 3, [-1e30] * 3, None
    for g in ge:
        if not isinstance(g, GeometryInstance):
            continue
        bb = g.GetSymbolGeometry().GetBoundingBox()
        if bb is None:
            continue
        if t is None:
            t = g.Transform
        for i, ax in enumerate('XYZ'):
            lo[i] = min(lo[i], getattr(bb.Min, ax))
            hi[i] = max(hi[i], getattr(bb.Max, ax))
    return ((lo, hi), t) if t is not None else None


def obstacle_record(inst, flags):
    lb = local_bounds(inst)
    if lb:
        (lo, hi), t = lb
    else:                                          # no family geometry: world-aligned box
        bb = inst.get_BoundingBox(None)
        if bb is None:
            return None
        lo, hi = [bb.Min.X, bb.Min.Y, bb.Min.Z], [bb.Max.X, bb.Max.Y, bb.Max.Z]
        t = Transform.Identity
    mark = inst.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)
    rec = {
        'id': eid(inst.Id),
        'unique_id': inst.UniqueId,
        'mark': mark.AsString() if mark and mark.HasValue else None,
        'family': inst.Symbol.Family.Name,
        'type': inst.Symbol.Name,
        'origin_mm': [to_mm(t.Origin.X), to_mm(t.Origin.Y), to_mm(t.Origin.Z)],
        'family_x_axis': [round(t.BasisX.X, 6), round(t.BasisX.Y, 6), round(t.BasisX.Z, 6)],
        'family_y_axis': [round(t.BasisY.X, 6), round(t.BasisY.Y, 6), round(t.BasisY.Z, 6)],
        'rotation_deg': round(math.degrees(math.atan2(t.BasisX.Y, t.BasisX.X)), 3),
        'mirrored': inst.Mirrored,
        'local_min_mm': [to_mm(v) for v in lo],
        'local_max_mm': [to_mm(v) for v in hi],
    }
    rec.update(flags)
    return rec


def export():
    data = {'units': 'mm', 'source': doc.PathName, 'document': doc.Title, 'families': [], 'obstacles': []}
    if doc.IsFamilyDocument:
        data['families'].append({'family': doc.Title, 'planes': plane_records(doc), 'instances': []})
    else:
        fams = {}
        for inst in FilteredElementCollector(doc).OfClass(FamilyInstance).WhereElementIsNotElementType():
            fam = inst.Symbol.Family
            key = eid(fam.Id)
            if key not in fams:
                planes = []
                if fam.IsEditable:
                    famdoc = doc.EditFamily(fam)
                    try:
                        planes = plane_records(famdoc)
                    finally:
                        famdoc.Close(False)
                fams[key] = {'family': fam.Name, 'planes': planes, 'instances': []} if planes else None
            flags = obstacle_flags(inst)
            if fams[key] is not None:
                # a manhole: its flags are the avoidance methods allowed to the runs
                # that leave it, applied to whatever those runs meet
                rec = instance_record(inst)
                if flags:
                    rec['params'] = {'obstacle_' + k: v for k, v in flags.items()}
                fams[key]['instances'].append(rec)
            elif flags:
                # anything else carrying the flags is an obstacle in its own right
                rec = obstacle_record(inst, flags)
                if rec:
                    data['obstacles'].append(rec)
        data['families'] = [f for f in fams.values() if f]
    base = os.path.splitext(doc.PathName)[0] if doc.PathName else os.path.join(os.path.expanduser('~'), 'manhole-export')
    # coordinates are Revit internal-origin coordinates in mm (survey/shared coordinates are not applied)
    path = base + '-manholes.json'
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)
    print('Wrote {} ({} families, {} obstacles)'.format(path, len(data['families']), len(data['obstacles'])))


export()
