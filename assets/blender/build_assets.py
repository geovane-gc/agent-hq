"""Builds every Agent HQ 3D model procedurally and exports them as glTF (.glb).

Run with Blender 4.2+ (tested on 5.2):

    blender --background --factory-startup --python assets/blender/build_assets.py -- \
        --out apps/web/public/models [--preview <dir>] [--only character,desk]

Conventions (Blender is Z-up; glTF/three.js is Y-up, three z = -blender y):
  * Origins sit on the floor (z = 0) at the footprint's center.
  * The "user side" of furniture faces -Y; characters face +Y, so a character
    standing on -Y looks at a desk's screen.
  * Materials are named so the game can recolor them per instance:
    Skin, Hair, Shirt (characters), Upholstery (chairs), Accent (desk panels),
    Screen (monitor surface, replaced with the live screen material).
"""

import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

# --------------------------------------------------------------------------- args

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default


OUT = os.path.abspath(arg("--out", "apps/web/public/models"))
PREVIEW = arg("--preview")
ONLY = set(filter(None, (arg("--only") or "").split(",")))
os.makedirs(OUT, exist_ok=True)
if PREVIEW:
    os.makedirs(PREVIEW, exist_ok=True)

FPS = 24

# --------------------------------------------------------------------------- scene helpers


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = FPS


def hex_color(h):
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    srgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    # Blender stores linear values; glTF exports them as-is (linear factors).
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    return (*lin, 1.0)


_materials = {}


def mat(name, color, rough=0.75, metal=0.0, emit=0.0):
    key = name
    if key in _materials and _materials[key].name in bpy.data.materials:
        return _materials[key]
    m = bpy.data.materials.new(name)
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    rgba = hex_color(color)
    bsdf.inputs["Base Color"].default_value = rgba
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if emit:
        bsdf.inputs["Emission Color"].default_value = rgba
        bsdf.inputs["Emission Strength"].default_value = emit
    m.diffuse_color = rgba
    _materials[key] = m
    return m


def _object(name, bm, material, smooth):
    for f in bm.faces:
        f.smooth = smooth
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(material)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def _place(bm, size=None, loc=(0, 0, 0), rot=(0, 0, 0)):
    if size is not None:
        bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    m = Matrix.Translation(Vector(loc)) @ (
        Matrix.Rotation(rot[2], 4, "Z") @ Matrix.Rotation(rot[1], 4, "Y") @ Matrix.Rotation(rot[0], 4, "X")
    )
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)


def box(name, size, loc, material, bevel=0.0, seg=2, rot=(0, 0, 0), smooth=False):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    if bevel:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, offset_type="OFFSET",
                        segments=seg, profile=0.5, affect="EDGES", clamp_overlap=True)
    _place(bm, None, loc, rot)
    return _object(name, bm, material, smooth)


def cyl(name, r, depth, loc, material, r2=None, verts=20, rot=(0, 0, 0), smooth=True):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=verts,
                          radius1=r, radius2=r if r2 is None else r2, depth=depth)
    _place(bm, None, loc, rot)
    obj = _object(name, bm, material, smooth)
    # keep the caps flat-shaded so edges read cleanly
    for p in obj.data.polygons:
        if abs(p.normal.z) > 0.99 and rot == (0, 0, 0):
            p.use_smooth = False
    return obj


def sphere(name, r, loc, material, scale=(1, 1, 1), seg=18, rings=12, rot=(0, 0, 0), smooth=True, cut=None):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=r)
    bmesh.ops.scale(bm, vec=Vector(scale), verts=bm.verts)
    if cut:
        doomed = [v for v in bm.verts if cut(v.co)]
        bmesh.ops.delete(bm, geom=doomed, context="VERTS")
    _place(bm, None, loc, rot)
    return _object(name, bm, material, smooth)


def ico(name, r, loc, material, scale=(1, 1, 1), subdiv=1, rot=(0, 0, 0)):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=r)
    bmesh.ops.scale(bm, vec=Vector(scale), verts=bm.verts)
    _place(bm, None, loc, rot)
    return _object(name, bm, material, False)


def plane(name, size, loc, material, rot=(0, 0, 0)):
    """A rectangle with 0..1 UVs, lying in XY before rotation."""
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=0.5, calc_uvs=True)
    # normalize to exactly size[0] x size[1]
    xs = [v.co.x for v in bm.verts]
    ys = [v.co.y for v in bm.verts]
    sx = size[0] / (max(xs) - min(xs))
    sy = size[1] / (max(ys) - min(ys))
    bmesh.ops.scale(bm, vec=Vector((sx, sy, 1)), verts=bm.verts)
    for f in bm.faces:
        for loop in f.loops:
            loop[uv].uv = ((loop.vert.co.x / size[0]) + 0.5, (loop.vert.co.y / size[1]) + 0.5)
    _place(bm, None, loc, rot)
    return _object(name, bm, material, False)


def text_mesh(name, body, size, loc, material, rot=(0, 0, 0), depth=0.004):
    curve = bpy.data.curves.new(name, "FONT")
    curve.body = body
    curve.size = size
    curve.extrude = depth
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    obj = bpy.data.objects.new(name, curve)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = loc
    obj.rotation_euler = rot
    dg = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(dg))
    mobj = bpy.data.objects.new(name, mesh)
    mobj.matrix_world = obj.matrix_world.copy()
    bpy.context.scene.collection.objects.link(mobj)
    bpy.data.objects.remove(obj)
    mesh.materials.clear()
    mesh.materials.append(material)
    return mobj


def join_all(name):
    """Merges every mesh in the scene into one object with its origin at the world origin."""
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    anchor_mesh = bpy.data.meshes.new(name)
    anchor = bpy.data.objects.new(name, anchor_mesh)
    bpy.context.scene.collection.objects.link(anchor)
    with bpy.context.temp_override(active_object=anchor, selected_editable_objects=objs + [anchor],
                                   object=anchor, selected_objects=objs + [anchor]):
        bpy.ops.object.join()
    anchor.name = name
    return anchor


def export(name, animations=False):
    path = os.path.join(OUT, f"{name}.glb")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=False,
        export_apply=True,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_animations=animations,
        **({"export_animation_mode": "ACTIONS", "export_force_sampling": True, "export_frame_step": 1} if animations else {}),
    )
    print(f"exported {path} ({os.path.getsize(path) // 1024} KB)")


def preview(name, frames=None, angle=(-0.9, -1.3, 0.75)):
    """Workbench render(s) for eyeballing the result."""
    if not PREVIEW:
        return
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.render.resolution_x = scene.render.resolution_y = 480
    scene.render.film_transparent = False
    world = bpy.data.worlds.new("w")
    scene.world = world
    world.color = (0.82, 0.86, 0.9)

    pts = []
    for o in scene.objects:
        if o.type == "MESH" and not o.hide_render:
            pts += [o.matrix_world @ Vector(c) for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    center = (lo + hi) / 2
    radius = (hi - lo).length / 2
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = 50
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    direction = Vector(angle).normalized()
    cam.location = center + direction * radius * 3.1
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    for frame, suffix in (frames or [(1, "")]):
        scene.frame_set(frame)
        scene.render.filepath = os.path.join(PREVIEW, f"{name}{suffix}.png")
        bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)


def wanted(name):
    return not ONLY or name in ONLY


# --------------------------------------------------------------------------- palette

WOOD_LIGHT = "#f2efe9"
METAL = "#8b8f98"
DARK = "#2a2d34"


# --------------------------------------------------------------------------- furniture


def build_desk():
    top = mat("DeskTop", WOOD_LIGHT, 0.55)
    leg = mat("Metal", METAL, 0.45, 0.3)
    accent = mat("Accent", "#3d63dd", 0.9)
    box("top", (1.4, 0.75, 0.05), (0, 0, 0.74), top, bevel=0.012)
    for x in (-0.66, 0.66):
        for y in (-0.32, 0.32):
            box("leg", (0.045, 0.045, 0.72), (x, y, 0.36), leg, bevel=0.01)
        box("foot", (0.06, 0.7, 0.03), (x, 0, 0.015), leg, bevel=0.01)
    box("rail", (1.28, 0.03, 0.05), (0, 0.32, 0.66), leg)
    # privacy panel facing the opposite desk
    box("panel", (1.4, 0.04, 0.45), (0, 0.39, 0.98), accent, bevel=0.015)
    # props: mug, notebook, pen cup
    cyl("mug", 0.04, 0.09, (-0.52, -0.12, 0.81), mat("Mug", "#f7f7f7", 0.4))
    cyl("coffee", 0.034, 0.005, (-0.52, -0.12, 0.853), mat("Coffee", "#4a2c1a", 0.3), smooth=False)
    box("notebook", (0.16, 0.22, 0.015), (0.5, -0.12, 0.773), mat("Notebook", "#e5484d", 0.8), rot=(0, 0, 0.25))
    cyl("pens", 0.03, 0.08, (0.55, 0.18, 0.805), mat("PenCup", "#2a2d34", 0.5))
    for i, c in enumerate(("#3d63dd", "#30a46c", "#f76b15")):
        cyl(f"pen{i}", 0.006, 0.12, (0.54 + i * 0.012, 0.18, 0.86), mat(f"Pen{i}", c), rot=(0.15 * (i - 1), 0.1, 0))
    join_all("Desk")


def build_monitor():
    body = mat("MonitorBody", "#1c1e24", 0.35, 0.2)
    stand = mat("MonitorStand", DARK, 0.4, 0.4)
    box("base", (0.24, 0.17, 0.02), (0, 0.03, 0.01), stand, bevel=0.008)
    box("neck", (0.05, 0.035, 0.26), (0, 0.06, 0.14), stand, bevel=0.01)
    box("bezel", (0.68, 0.045, 0.43), (0, 0.035, 0.38), body, bevel=0.012)
    box("back", (0.3, 0.05, 0.2), (0, 0.07, 0.38), body, bevel=0.02)
    # facing -Y (towards the user); UVs upright for the scrolling code texture
    plane("Screen", (0.62, 0.37), (0, 0.011, 0.385), mat("Screen", "#202840", 0.2), rot=(math.pi / 2, 0, 0))
    sphere("led", 0.006, (0.3, 0.011, 0.18), mat("Led", "#3dff7a", 0.3, emit=2.0), seg=8, rings=6)
    join_all("Monitor")


def build_keyboard():
    base = mat("KeyboardBody", "#d9d9de", 0.5)
    keys = mat("Keys", "#f4f4f6", 0.6)
    box("board", (0.44, 0.15, 0.018), (0, 0, 0.009), base, bevel=0.005)
    for row in range(4):
        for col in range(12):
            box("key", (0.03, 0.026, 0.01), (-0.198 + col * 0.036, -0.05 + row * 0.033, 0.022), keys, bevel=0.003, seg=1)
    box("space", (0.2, 0.026, 0.01), (0, -0.083, 0.022), keys, bevel=0.003, seg=1)
    sphere("mouse", 0.035, (0.31, 0, 0.012), mat("Mouse", "#2a2d34", 0.4), scale=(0.9, 1.4, 0.55))
    box("pad", (0.2, 0.22, 0.004), (0.31, 0, 0.002), mat("MousePad", "#3a3f4b", 0.9))
    join_all("Keyboard")


def build_chair():
    up = mat("Upholstery", "#5b6170", 0.85)
    plastic = mat("ChairPlastic", "#26282e", 0.5)
    chrome = mat("Chrome", "#b9bec7", 0.25, 0.8)
    box("seat", (0.5, 0.48, 0.08), (0, 0, 0.46), up, bevel=0.035, seg=3)
    box("seatShell", (0.46, 0.44, 0.03), (0, 0, 0.41), plastic, bevel=0.01)
    box("back", (0.46, 0.07, 0.56), (0, -0.27, 0.82), up, bevel=0.035, seg=3, rot=(-0.12, 0, 0))
    box("spine", (0.06, 0.04, 0.3), (0, -0.25, 0.55), plastic, rot=(-0.3, 0, 0))
    for x in (-0.27, 0.27):
        box("armPost", (0.035, 0.035, 0.2), (x, 0.02, 0.56), plastic)
        box("armPad", (0.06, 0.26, 0.035), (x, 0.03, 0.67), plastic, bevel=0.012)
    cyl("lift", 0.028, 0.32, (0, 0, 0.24), chrome, verts=12)
    cyl("hub", 0.06, 0.05, (0, 0, 0.09), plastic, verts=12)
    for i in range(5):
        a = i / 5 * math.tau
        box("leg", (0.04, 0.3, 0.035), (math.sin(a) * 0.15, math.cos(a) * 0.15, 0.07), plastic, rot=(0, 0, -a))
        sphere("caster", 0.028, (math.sin(a) * 0.29, math.cos(a) * 0.29, 0.028), plastic, seg=10, rings=6)
    join_all("Chair")


def build_boss_chair():
    leather = mat("Leather", "#1e1e22", 0.45)
    chrome = mat("Chrome", "#c9ced6", 0.2, 0.9)
    box("seat", (0.6, 0.56, 0.12), (0, 0, 0.48), leather, bevel=0.05, seg=3)
    box("back", (0.58, 0.12, 0.85), (0, -0.3, 0.98), leather, bevel=0.06, seg=3, rot=(-0.1, 0, 0))
    box("headrest", (0.4, 0.12, 0.18), (0, -0.36, 1.48), leather, bevel=0.05, seg=3, rot=(-0.1, 0, 0))
    for x in (-0.33, 0.33):
        box("arm", (0.08, 0.45, 0.07), (x, 0.0, 0.7), leather, bevel=0.03)
        box("armPost", (0.04, 0.04, 0.18), (x, 0.05, 0.6), chrome)
    cyl("lift", 0.035, 0.3, (0, 0, 0.26), chrome, verts=12)
    for i in range(5):
        a = i / 5 * math.tau
        box("leg", (0.05, 0.36, 0.04), (math.sin(a) * 0.18, math.cos(a) * 0.18, 0.08), chrome, rot=(0, 0, -a))
        sphere("caster", 0.03, (math.sin(a) * 0.34, math.cos(a) * 0.34, 0.03), mat("Caster", "#111", 0.5), seg=10, rings=6)
    join_all("BossChair")


def build_boss_desk():
    wood = mat("WalnutTop", "#5b3a26", 0.4)
    dark = mat("Walnut", "#4a2f1f", 0.55)
    gold = mat("Gold", "#d4a73c", 0.25, 1.0)
    box("top", (2.2, 1.0, 0.07), (0, 0, 0.76), wood, bevel=0.02)
    for x in (-0.82, 0.82):
        box("pedestal", (0.5, 0.9, 0.72), (x, 0, 0.36), dark, bevel=0.01)
        for z in (0.18, 0.42, 0.62):
            box("drawer", (0.44, 0.01, 0.17), (x, -0.455, z), wood, bevel=0.005)
            box("handle", (0.12, 0.02, 0.015), (x, -0.465, z + 0.04), gold)
    box("modesty", (1.14, 0.04, 0.55), (0, 0.42, 0.45), dark)
    # nameplate facing visitors (+Y)
    box("plate", (0.4, 0.06, 0.08), (0, 0.32, 0.835), dark, bevel=0.01, rot=(-0.4, 0, 0))
    text_mesh("name", "BOSS", 0.07, (0, 0.355, 0.85), gold, rot=(math.pi / 2 - 0.4, 0, math.pi))
    box("blotter", (0.6, 0.4, 0.006), (0, -0.15, 0.798), mat("Blotter", "#1f3b2c", 0.9))
    cyl("lampBase", 0.07, 0.02, (-0.85, 0.25, 0.805), gold, verts=16)
    cyl("lampPole", 0.01, 0.32, (-0.85, 0.25, 0.97), gold, verts=8)
    cyl("lampShade", 0.11, 0.1, (-0.85, 0.25, 1.15), mat("LampShade", "#1f6b3a", 0.6), r2=0.06)
    join_all("BossDesk")


def build_plant():
    pot = mat("Pot", "#c4683f", 0.8)
    soil = mat("Soil", "#3b2a1a", 1.0)
    leaf = mat("Leaf", "#3f9a54", 0.7)
    leaf2 = mat("LeafDark", "#2f7d45", 0.7)
    cyl("pot", 0.2, 0.38, (0, 0, 0.19), pot, r2=0.16, verts=14, smooth=False)
    cyl("rim", 0.215, 0.05, (0, 0, 0.37), pot, verts=14, smooth=False)
    cyl("soil", 0.19, 0.02, (0, 0, 0.385), soil, verts=14, smooth=False)
    for i in range(9):
        a = i * 2.39996
        tilt = 0.35 + (i % 3) * 0.18
        h = 0.55 + (i % 4) * 0.08
        ico("leaf", 0.13, (math.cos(a) * 0.1, math.sin(a) * 0.1, h), leaf if i % 2 else leaf2,
            scale=(0.6, 1.0, 1.7), rot=(tilt, 0, a + math.pi / 2))
    join_all("Plant")


def build_plant_tall():
    pot = mat("PotWhite", "#e9e6df", 0.6)
    trunk = mat("Trunk", "#6b4a2b", 0.9)
    leaf = mat("Leaf", "#3f9a54", 0.7)
    leaf2 = mat("LeafDark", "#2f7d45", 0.7)
    cyl("pot", 0.22, 0.42, (0, 0, 0.21), pot, r2=0.2, verts=16)
    cyl("soil", 0.2, 0.02, (0, 0, 0.42), mat("Soil", "#3b2a1a", 1.0), verts=16, smooth=False)
    cyl("trunk", 0.025, 1.0, (0, 0, 0.9), trunk, r2=0.018, verts=8)
    for i in range(14):
        a = i * 2.39996
        z = 0.9 + i * 0.065
        r = 0.16 + (i % 3) * 0.04
        ico("leaf", 0.11, (math.cos(a) * r, math.sin(a) * r, z), leaf if i % 2 else leaf2,
            scale=(1.0, 0.35, 1.25), rot=(0.4, 0, a + math.pi / 2))
    join_all("PlantTall")


def build_sofa():
    fabric = mat("Fabric", "#5b6b8c", 0.95)
    cushion = mat("Cushion", "#6c7da0", 0.95)
    legm = mat("SofaLeg", "#3b2a1a", 0.6)
    box("base", (2.0, 0.85, 0.3), (0, 0, 0.25), fabric, bevel=0.04)
    box("back", (2.0, 0.22, 0.5), (0, 0.32, 0.62), fabric, bevel=0.06, seg=3)
    for x in (-0.94, 0.94):
        box("arm", (0.16, 0.85, 0.42), (x, 0, 0.45), fabric, bevel=0.06, seg=3)
    for x in (-0.58, 0, 0.58):
        box("seat", (0.56, 0.62, 0.14), (x, -0.08, 0.46), cushion, bevel=0.05, seg=3)
        box("pillow", (0.5, 0.14, 0.36), (x, 0.17, 0.7), cushion, bevel=0.06, seg=3, rot=(-0.2, 0, 0))
    for x in (-0.9, 0.9):
        for y in (-0.35, 0.35):
            cyl("leg", 0.03, 0.1, (x, y, 0.05), legm, r2=0.02, verts=8)
    join_all("Sofa")


def build_coffee_table():
    wood = mat("Wood", "#8a5a3b", 0.5)
    dark = mat("TableLeg", "#2a2d34", 0.5)
    cyl("top", 0.48, 0.05, (0, 0, 0.42), wood, verts=28)
    for i in range(3):
        a = i / 3 * math.tau
        cyl("leg", 0.022, 0.42, (math.cos(a) * 0.28, math.sin(a) * 0.28, 0.2), dark, verts=8, rot=(0, 0, 0))
    cyl("cup", 0.04, 0.08, (0.15, -0.1, 0.485), mat("Mug", "#f7f7f7", 0.4))
    box("book", (0.22, 0.3, 0.03), (-0.12, 0.08, 0.46), mat("Book", "#e5484d", 0.8), rot=(0, 0, 0.4))
    box("book2", (0.2, 0.27, 0.025), (-0.1, 0.06, 0.487), mat("Book2", "#30a46c", 0.8), rot=(0, 0, 0.2))
    join_all("CoffeeTable")


def build_coffee_machine():
    counter = mat("Counter", "#e9e9e6", 0.5)
    top = mat("CounterTop", "#3a3f4b", 0.4)
    body = mat("MachineBody", "#26282e", 0.35, 0.3)
    steel = mat("Steel", "#c9ced6", 0.25, 0.9)
    box("counter", (0.9, 0.6, 0.86), (0, 0, 0.43), counter, bevel=0.01)
    box("counterTop", (0.94, 0.64, 0.04), (0, 0, 0.88), top, bevel=0.008)
    for x in (-0.22, 0.22):
        box("door", (0.42, 0.01, 0.78), (x, -0.302, 0.43), counter)
        box("knob", (0.015, 0.02, 0.12), (x + (0.17 if x < 0 else -0.17), -0.31, 0.6), steel)
    box("machine", (0.36, 0.34, 0.42), (-0.15, 0.05, 1.11), body, bevel=0.03)
    box("head", (0.3, 0.12, 0.08), (-0.15, -0.12, 1.2), steel, bevel=0.01)
    cyl("spout", 0.025, 0.06, (-0.15, -0.14, 1.13), steel, verts=10)
    box("tray", (0.26, 0.14, 0.02), (-0.15, -0.12, 0.92), steel)
    cyl("cup", 0.035, 0.07, (-0.15, -0.13, 0.965), mat("Mug", "#f7f7f7", 0.4))
    sphere("led", 0.012, (0.0, -0.121, 1.27), mat("Led", "#3dff7a", 0.3, emit=2.0), seg=8, rings=6)
    cyl("jar", 0.07, 0.2, (0.25, 0.05, 1.0), mat("Glass", "#c7d6e0", 0.1), verts=16)
    cyl("beans", 0.065, 0.12, (0.25, 0.05, 0.96), mat("Beans", "#4a2c1a", 0.8), verts=16)
    join_all("CoffeeMachine")


def build_whiteboard():
    frame = mat("Aluminum", "#a7adb7", 0.35, 0.6)
    board = mat("Board", "#fafafa", 0.25)
    box("frame", (3.3, 0.05, 1.6), (0, -0.025, 1.6), frame, bevel=0.01)
    box("board", (3.2, 0.02, 1.5), (0, -0.055, 1.6), board)
    box("tray", (3.0, 0.1, 0.03), (0, -0.1, 0.83), frame, bevel=0.008)
    for i, c in enumerate(("#e5484d", "#3d63dd", "#30a46c")):
        cyl(f"marker{i}", 0.012, 0.13, (-1.2 + i * 0.16, -0.1, 0.858), mat(f"Marker{i}", c), rot=(0, math.pi / 2, 0), verts=8)
    box("eraser", (0.14, 0.06, 0.04), (1.1, -0.1, 0.865), mat("Eraser", "#2a2d34"))
    # column headers drawn as lines on the board
    ink = mat("Ink", "#3a3f4b", 0.6)
    for i in range(4):
        box("header", (0.5, 0.004, 0.02), (-1.2 + i * 0.8, -0.066, 2.25), ink)
        if i:
            box("divider", (0.008, 0.004, 1.3), (-1.6 + i * 0.8, -0.066, 1.6), ink)
    join_all("Whiteboard")


def build_elevator():
    frame = mat("ElevatorFrame", "#7d838e", 0.5, 0.2)
    door = mat("ElevatorDoor", "#c9ced6", 0.3, 0.6)
    box("frame", (1.8, 0.16, 2.5), (0, -0.08, 1.25), frame, bevel=0.02)
    box("recess", (1.5, 0.05, 2.2), (0, -0.165, 1.1), mat("Recess", "#3a3f4b", 0.6))
    for x in (-0.37, 0.37):
        box("door", (0.72, 0.04, 2.15), (x, -0.19, 1.08), door, bevel=0.008)
        box("stripe", (0.6, 0.005, 0.02), (x, -0.212, 1.1), frame)
    box("display", (0.5, 0.02, 0.2), (0, -0.17, 2.36), mat("Display", "#111111", 0.3))
    box("arrow", (0.06, 0.005, 0.06), (-0.16, -0.181, 2.36), mat("Led", "#ff9f1a", 0.3, emit=2.0), rot=(0, math.pi / 4, 0))
    box("panel", (0.12, 0.03, 0.26), (1.02, -0.02, 1.2), frame, bevel=0.01)
    for z in (1.26, 1.14):
        cyl("button", 0.022, 0.02, (1.02, -0.04, z), mat("Button", "#f2efe9", 0.3, emit=0.6), rot=(math.pi / 2, 0, 0), verts=12)
    join_all("Elevator")


def build_floor_lamp():
    metal = mat("LampMetal", "#2a2d34", 0.4, 0.5)
    cyl("base", 0.16, 0.03, (0, 0, 0.015), metal, verts=20)
    cyl("pole", 0.012, 1.5, (0, 0, 0.78), metal, verts=8)
    cyl("shade", 0.22, 0.28, (0, 0, 1.55), mat("Shade", "#f3e6c8", 0.8, emit=0.4), r2=0.14, verts=20)
    join_all("FloorLamp")


def build_tree():
    trunk = mat("Bark", "#7a5232", 0.9)
    leaf = mat("Pine", "#3f8f4f", 0.8)
    leaf2 = mat("PineDark", "#2f7a42", 0.8)
    cyl("trunk", 0.12, 0.8, (0, 0, 0.4), trunk, r2=0.09, verts=7, smooth=False)
    for i, (z, r, h) in enumerate(((0.95, 0.85, 1.0), (1.5, 0.65, 0.85), (1.95, 0.45, 0.7))):
        cyl("cone", r, h, (0, 0, z), leaf if i % 2 else leaf2, r2=0.0, verts=8, smooth=False, rot=(0, 0, i * 0.4))
    join_all("Tree")


def build_tree_round():
    trunk = mat("Bark", "#7a5232", 0.9)
    leaf = mat("Foliage", "#5aa65c", 0.8)
    cyl("trunk", 0.1, 1.0, (0, 0, 0.5), trunk, r2=0.08, verts=7, smooth=False)
    for (x, y, z, r) in ((0, 0, 1.55, 0.6), (0.3, 0.15, 1.35, 0.42), (-0.28, -0.1, 1.4, 0.45), (0.05, -0.25, 1.85, 0.38)):
        ico("blob", r, (x, y, z), leaf, subdiv=1)
    join_all("TreeRound")


# --------------------------------------------------------------------------- character

BONES = {
    # name: (head, tail, parent)
    "Hips": ((0, 0, 0.95), (0, 0, 1.05), None),
    "Spine": ((0, 0, 1.05), (0, 0, 1.42), "Hips"),
    "Head": ((0, 0, 1.45), (0, 0, 1.8), "Spine"),
    "UpperArm.L": ((-0.25, 0, 1.39), (-0.25, 0, 1.12), "Spine"),
    "Forearm.L": ((-0.25, 0, 1.12), (-0.25, 0, 0.87), "UpperArm.L"),
    "UpperArm.R": ((0.25, 0, 1.39), (0.25, 0, 1.12), "Spine"),
    "Forearm.R": ((0.25, 0, 1.12), (0.25, 0, 0.87), "UpperArm.R"),
    "Thigh.L": ((-0.1, 0, 0.93), (-0.1, 0, 0.52), "Hips"),
    "Shin.L": ((-0.1, 0, 0.52), (-0.1, 0, 0.08), "Thigh.L"),
    "Thigh.R": ((0.1, 0, 0.93), (0.1, 0, 0.52), "Hips"),
    "Shin.R": ((0.1, 0, 0.52), (0.1, 0, 0.08), "Thigh.R"),
}


def make_armature():
    data = bpy.data.armatures.new("Rig")
    arm = bpy.data.objects.new("Rig", data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    for name, (head, tail, parent) in BONES.items():
        b = data.edit_bones.new(name)
        b.head, b.tail, b.roll = head, tail, 0.0
    for name, (_, _, parent) in BONES.items():
        if parent:
            data.edit_bones[name].parent = data.edit_bones[parent]
            data.edit_bones[name].use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    for pb in arm.pose.bones:
        pb.rotation_mode = "XYZ"
    return arm


def attach(obj, arm, bone):
    world = obj.matrix_world.copy()
    obj.parent = arm
    obj.parent_type = "BONE"
    obj.parent_bone = bone
    bpy.context.view_layer.update()
    obj.matrix_world = world


def build_character_meshes(arm):
    skin = mat("Skin", "#e0ac69", 0.65)
    hair = mat("Hair", "#3b2a1a", 0.85)
    shirt = mat("Shirt", "#3d63dd", 0.85)
    pants = mat("Pants", "#2d3446", 0.9)
    shoes = mat("Shoes", "#1b1b1f", 0.5)
    eyes = mat("Eyes", "#141414", 0.3)
    mouth = mat("Mouth", "#9b4a45", 0.6)
    white = mat("EyeWhite", "#ffffff", 0.4)

    attach(box("Pelvis", (0.34, 0.2, 0.16), (0, 0, 0.96), pants, bevel=0.04, seg=3), arm, "Hips")
    attach(box("Belt", (0.35, 0.21, 0.035), (0, 0, 1.03), mat("Belt", "#1b1b1f", 0.5), bevel=0.01), arm, "Hips")
    attach(box("Torso", (0.4, 0.23, 0.42), (0, 0, 1.22), shirt, bevel=0.07, seg=3, smooth=True), arm, "Spine")
    attach(box("Collar", (0.18, 0.12, 0.03), (0, 0.04, 1.43), shirt, bevel=0.012), arm, "Spine")
    attach(cyl("Neck", 0.055, 0.08, (0, 0, 1.45), skin, verts=12), arm, "Spine")

    # Optional suit (the boss wears it so players can tell who runs the office).
    # Every piece is named Outfit_Suit*; the game toggles them together.
    suit = mat("Suit", "#1f2a44", 0.6)
    shirt_white = mat("DressShirt", "#f4f4f2", 0.5)
    tie = mat("Tie", "#b3262d", 0.5)
    attach(box("Outfit_Suit", (0.43, 0.255, 0.44), (0, 0, 1.215), suit, bevel=0.075, seg=3, smooth=True), arm, "Spine")
    attach(box("Outfit_SuitShirt", (0.12, 0.02, 0.2), (0, 0.124, 1.33), shirt_white, bevel=0.005), arm, "Spine")
    attach(box("Outfit_SuitTie", (0.045, 0.02, 0.24), (0, 0.137, 1.29), tie, bevel=0.006), arm, "Spine")
    attach(box("Outfit_SuitKnot", (0.055, 0.025, 0.04), (0, 0.137, 1.415), tie, bevel=0.008), arm, "Spine")
    for side in (-1, 1):
        attach(box("Outfit_SuitLapel", (0.06, 0.02, 0.2), (side * 0.085, 0.128, 1.32), suit, bevel=0.006, rot=(0, side * 0.35, 0)), arm, "Spine")
    for side, suffix in ((-1, "L"), (1, "R")):
        attach(box(f"Outfit_SuitSleeve.{suffix}", (0.12, 0.12, 0.28), (side * 0.25, 0, 1.26), suit, bevel=0.04, seg=2, smooth=True), arm, f"UpperArm.{suffix}")
        attach(box(f"Outfit_SuitCuff.{suffix}", (0.095, 0.095, 0.14), (side * 0.25, 0, 1.06), suit, bevel=0.03, seg=2, smooth=True), arm, f"Forearm.{suffix}")

    attach(sphere("HeadMesh", 0.165, (0, 0, 1.62), skin, scale=(1, 0.95, 1.06), seg=20, rings=14), arm, "Head")
    for side in (-1, 1):
        attach(sphere("EyeWhite", 0.03, (side * 0.058, 0.138, 1.635), white, scale=(1, 0.5, 1.1), seg=10, rings=8), arm, "Head")
        attach(sphere("Eye", 0.019, (side * 0.058, 0.152, 1.635), eyes, seg=10, rings=8), arm, "Head")
        attach(box("Brow", (0.05, 0.012, 0.013), (side * 0.058, 0.152, 1.69), hair, bevel=0.004, rot=(0, side * 0.12, 0)), arm, "Head")
        attach(sphere("Ear", 0.04, (side * 0.163, 0, 1.615), skin, scale=(0.5, 1, 1.2), seg=10, rings=8), arm, "Head")
    attach(sphere("Nose", 0.024, (0, 0.165, 1.6), skin, scale=(0.9, 1, 1.1), seg=10, rings=8), arm, "Head")
    attach(box("Mouth", (0.055, 0.012, 0.012), (0, 0.15, 1.545), mouth, bevel=0.005), arm, "Head")

    # hair styles: the game shows one per agent by node name
    def cap_cut(co):
        # keep the top and back of the skull, open the face
        return (co.z < 0.02 and co.y > -0.06) or co.z < -0.09

    attach(sphere("Hair_Short", 0.176, (0, -0.012, 1.625), hair, scale=(1, 0.98, 1.0), seg=20, rings=14, cut=cap_cut), arm, "Head")
    attach(sphere("Hair_Long", 0.178, (0, -0.012, 1.625), hair, scale=(1.02, 1.0, 1.0), seg=20, rings=14, cut=cap_cut), arm, "Head")
    long_back = box("Hair_LongBack", (0.32, 0.1, 0.34), (0, -0.12, 1.47), hair, bevel=0.045, seg=3, smooth=True)
    attach(sphere("Hair_Bun", 0.176, (0, -0.012, 1.625), hair, scale=(1, 0.98, 1.0), seg=20, rings=14, cut=cap_cut), arm, "Head")
    bun = sphere("Hair_BunKnot", 0.075, (0, -0.1, 1.79), hair, seg=12, rings=8)
    attach(long_back, arm, "Head")
    attach(bun, arm, "Head")
    # Group extra pieces under their style so toggling one node shows/hides both.
    for child, parent_name in ((long_back, "Hair_Long"), (bun, "Hair_Bun")):
        parent = bpy.data.objects[parent_name]
        world = child.matrix_world.copy()
        child.parent = parent
        child.parent_type = "OBJECT"
        bpy.context.view_layer.update()
        child.matrix_world = world

    for side, suffix in ((-1, "L"), (1, "R")):
        x = side * 0.25
        attach(box(f"Sleeve.{suffix}", (0.11, 0.11, 0.27), (x, 0, 1.26), shirt, bevel=0.035, seg=2, smooth=True), arm, f"UpperArm.{suffix}")
        attach(box(f"ForearmMesh.{suffix}", (0.085, 0.085, 0.24), (x, 0, 1.0), skin, bevel=0.03, seg=2, smooth=True), arm, f"Forearm.{suffix}")
        attach(sphere(f"Hand.{suffix}", 0.052, (x, 0.005, 0.845), skin, scale=(0.9, 0.8, 1.15), seg=12, rings=8), arm, f"Forearm.{suffix}")
        x = side * 0.1
        attach(box(f"ThighMesh.{suffix}", (0.15, 0.16, 0.43), (x, 0, 0.73), pants, bevel=0.04, seg=2, smooth=True), arm, f"Thigh.{suffix}")
        attach(box(f"ShinMesh.{suffix}", (0.13, 0.14, 0.42), (x, 0, 0.3), pants, bevel=0.035, seg=2, smooth=True), arm, f"Shin.{suffix}")
        attach(box(f"Shoe.{suffix}", (0.13, 0.25, 0.08), (x, 0.045, 0.04), shoes, bevel=0.03, seg=2), arm, f"Shin.{suffix}")


def keyframe(arm, frame, pose):
    """pose: {bone: {"rot": (x, y, z), "loc": (x, y, z)}}; unspecified bones return to rest."""
    for pb in arm.pose.bones:
        p = pose.get(pb.name, {})
        pb.rotation_euler = p.get("rot", (0, 0, 0))
        pb.location = p.get("loc", (0, 0, 0))
        pb.keyframe_insert("rotation_euler", frame=frame)
        pb.keyframe_insert("location", frame=frame)


def action(arm, name, frames):
    """frames: list of (frame, pose). The first pose is repeated at the end for clean loops."""
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm.animation_data_create()
    arm.animation_data.action = act
    for frame, pose in frames:
        keyframe(arm, frame, pose)
    return act


def merge(*poses):
    out = {}
    for p in poses:
        for bone, v in p.items():
            out.setdefault(bone, {}).update(v)
    return out


# Rotation conventions for this rig (bones point along +Y of their local frame):
#   arms/legs (pointing down): +X swings forward (towards +Y).
#   spine/head (pointing up):  -X leans forward, +X leans back, Y turns the head.
SEAT = {"Hips": {"loc": (0, -0.45, 0)}, "Thigh.L": {"rot": (1.57, 0, 0)}, "Thigh.R": {"rot": (1.57, 0, 0)},
        "Shin.L": {"rot": (-1.57, 0, 0)}, "Shin.R": {"rot": (-1.57, 0, 0)}}
TYPE_ARMS = {"UpperArm.L": {"rot": (0.4, 0, 0.05)}, "Forearm.L": {"rot": (1.45, 0, 0)},
             "UpperArm.R": {"rot": (0.4, 0, -0.05)}, "Forearm.R": {"rot": (1.45, 0, 0)}}


def build_animations(arm):
    # Standing idle: gentle breathing.
    action(arm, "Stand", [(f, {"Spine": {"rot": (0.02 * math.sin(f / 48 * math.tau), 0, 0)},
                               "Head": {"rot": (0, 0.1 * math.sin(f / 48 * math.tau), 0)},
                               "UpperArm.L": {"rot": (0, 0, -0.06)}, "UpperArm.R": {"rot": (0, 0, 0.06)}})
                           for f in range(1, 50, 6)])

    # Walk cycle (24 frames).
    walk = []
    for f in range(1, 26, 2):
        t = (f - 1) / 24 * math.tau
        s = math.sin(t)
        walk.append((f, {
            "Hips": {"loc": (0, 0.03 * abs(math.cos(t)), 0)},
            "Thigh.L": {"rot": (0.5 * s, 0, 0)}, "Thigh.R": {"rot": (-0.5 * s, 0, 0)},
            "Shin.L": {"rot": (-0.6 * max(0, -s), 0, 0)}, "Shin.R": {"rot": (-0.6 * max(0, s), 0, 0)},
            "UpperArm.L": {"rot": (-0.45 * s, 0, -0.05)}, "UpperArm.R": {"rot": (0.45 * s, 0, 0.05)},
            "Forearm.L": {"rot": (0.3, 0, 0)}, "Forearm.R": {"rot": (0.3, 0, 0)},
            "Spine": {"rot": (-0.05, 0.06 * s, 0)},
        }))
    action(arm, "Walk", walk)

    # Seated, idle: leaning back, looking around, an occasional stretch.
    idle = []
    for f in range(1, 146, 6):
        t = (f - 1) / 144
        stretch = max(0.0, math.sin((t - 0.55) * math.tau * 2.2)) if 0.55 < t < 0.78 else 0.0
        idle.append((f, merge(SEAT, {
            "Spine": {"rot": (0.14, 0, 0)},
            "Head": {"rot": (-0.05, 0.5 * math.sin(t * math.tau), 0)},
            "UpperArm.L": {"rot": (0.35 + stretch * 2.5, 0, 0.1)}, "UpperArm.R": {"rot": (0.35 + stretch * 2.5, 0, -0.1)},
            "Forearm.L": {"rot": (0.9 - stretch * 0.6, 0, 0)}, "Forearm.R": {"rot": (0.9 - stretch * 0.6, 0, 0)},
        })))
    action(arm, "SitIdle", idle)

    # Seated, typing: fast alternating hands, small head bob.
    typing = []
    for f in range(1, 14):
        t = (f - 1) / 12 * math.tau
        typing.append((f, merge(SEAT, TYPE_ARMS, {
            "Spine": {"rot": (-0.1, 0, 0)},
            "Head": {"rot": (-0.12 + 0.03 * math.sin(t), 0.05 * math.sin(t / 2), 0)},
            "Forearm.L": {"rot": (1.45 + 0.12 * math.sin(t * 2), 0, 0)},
            "Forearm.R": {"rot": (1.45 + 0.12 * math.sin(t * 2 + 2), 0, 0)},
        })))
    action(arm, "SitType", typing)

    # Seated, waiting for approval: right hand up and waving.
    wave = []
    for f in range(1, 26, 2):
        t = (f - 1) / 24 * math.tau
        wave.append((f, merge(SEAT, {
            "Spine": {"rot": (0.04, 0, 0)},
            "Head": {"rot": (0.12, -0.25 + 0.08 * math.sin(t), 0)},
            "UpperArm.L": {"rot": (0.4, 0, 0.05)}, "Forearm.L": {"rot": (1.45, 0, 0)},
            "UpperArm.R": {"rot": (2.85, 0, -0.25)},
            "Forearm.R": {"rot": (0.25, 0, 0.45 * math.sin(t * 2))},
        })))
    action(arm, "SitWave", wave)

    # Seated, error: hands on head, shaking it.
    err = []
    for f in range(1, 26, 2):
        t = (f - 1) / 24 * math.tau
        err.append((f, merge(SEAT, {
            "Spine": {"rot": (-0.18, 0, 0)},
            "Head": {"rot": (-0.2, 0.3 * math.sin(t * 2), 0)},
            "UpperArm.L": {"rot": (2.2, 0, -0.55)}, "Forearm.L": {"rot": (1.9, 0, 0)},
            "UpperArm.R": {"rot": (2.2, 0, 0.55)}, "Forearm.R": {"rot": (1.9, 0, 0)},
        })))
    action(arm, "SitError", err)
    return ["Stand", "Walk", "SitIdle", "SitType", "SitWave", "SitError"]


def build_character():
    arm = make_armature()
    build_character_meshes(arm)
    names = build_animations(arm)
    return arm, names


# --------------------------------------------------------------------------- main

FURNITURE = {
    "desk": build_desk,
    "monitor": build_monitor,
    "keyboard": build_keyboard,
    "chair": build_chair,
    "boss_chair": build_boss_chair,
    "boss_desk": build_boss_desk,
    "plant": build_plant,
    "plant_tall": build_plant_tall,
    "sofa": build_sofa,
    "coffee_table": build_coffee_table,
    "coffee_machine": build_coffee_machine,
    "whiteboard": build_whiteboard,
    "elevator": build_elevator,
    "floor_lamp": build_floor_lamp,
    "tree": build_tree,
    "tree_round": build_tree_round,
}

for name, builder in FURNITURE.items():
    if not wanted(name):
        continue
    reset()
    _materials.clear()
    builder()
    export(name)
    preview(name)

if wanted("character"):
    reset()
    _materials.clear()
    rig, clips = build_character()
    for style in ("Hair_Long", "Hair_Bun"):
        bpy.data.objects[style].hide_render = True
        for child in bpy.data.objects[style].children:
            child.hide_render = True
    suit_parts = [o for o in bpy.data.objects if o.name.startswith("Outfit_Suit")]
    if PREVIEW:
        for o in suit_parts:
            o.hide_render = True
        for clip in clips:
            rig.animation_data.action = bpy.data.actions[clip]
            preview(f"character_{clip}", frames=[(5, "")], angle=(0.9, 1.6, 0.6))
            preview(f"character_{clip}_side", frames=[(5, "")], angle=(1.0, 0.0, 0.15))
        for o in suit_parts:
            o.hide_render = False
        for clip in ("Stand", "SitIdle"):
            rig.animation_data.action = bpy.data.actions[clip]
            preview(f"character_suit_{clip}", frames=[(5, "")], angle=(0.9, 1.6, 0.6))
    rig.animation_data.action = None
    for pb in rig.pose.bones:
        pb.rotation_euler = (0, 0, 0)
        pb.location = (0, 0, 0)
    for style in ("Hair_Long", "Hair_Bun"):
        bpy.data.objects[style].hide_render = False
        for child in bpy.data.objects[style].children:
            child.hide_render = False
    export("character", animations=True)

print("done")
