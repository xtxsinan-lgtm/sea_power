# Extract Sea Power ship/aircraft prefabs from the local Unity Resources file
# into glTF binary for the web viewer. Reads the user's own install; writes
# gitignored data/models/*.glb. Does not redistribute the game.
#
#   tools\_py\python\python.exe tools\extract_models.py
#   tools\_py\python\python.exe tools\extract_models.py --match oliver_hazard_perry --limit 1
#
# Resource path (from SeaPower.ObjectBaseLoader, ILSpy): ResourcesFolder + ResourcesRoot,
# loaded with Resources.Load<GameObject>.
import argparse
import json
import struct
import sys
from io import BytesIO
from pathlib import Path

import UnityPy
from UnityPy.helpers.MeshHelper import MeshHandler

GAME = Path(r"D:\Steam_new\steamapps\common\Sea Power")
DATA = GAME / "Sea Power_Data"
# Resource paths live on the ResourceManager inside globalgamemanagers.
# The prefabs themselves are in resources.assets (external file id).
MANAGERS = DATA / "globalgamemanagers"
ASSETS = DATA / "resources.assets"
SRC = DATA / "StreamingAssets" / "original"
OUT = Path(__file__).resolve().parent.parent / "data" / "models"


def _slash(folder):
    folder = (folder or "").replace("\\", "/")
    if folder and not folder.endswith("/"):
        folder += "/"
    return folder


def parse_sections(path):
    sections = {}
    cur = None
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.split("//", 1)[0].split("#", 1)[0].strip()
        if not line:
            continue
        if line.startswith("[") and line.endswith("]"):
            cur = line[1:-1].strip()
            sections.setdefault(cur, {})
            continue
        if cur and "=" in line:
            k, v = (s.strip() for s in line.split("=", 1))
            sections[cur][k] = v
    return sections


def read_model(path):
    """Resource path plus mesh-name → material-resource map (the game assigns materials from the INI, not the prefab)."""
    sections = parse_sections(path)
    models = sections.get("Models") or {}
    folder = _slash(models.get("ResourcesFolder"))
    root = models.get("ResourcesRoot")
    if not folder or not root:
        return None, {}
    mat_folder = _slash(models.get("ResourcesMaterialFolder") or folder)
    assign = {}
    if models.get("ResourcesMesh") and models.get("ResourcesMaterial"):
        assign[models["ResourcesMesh"]] = mat_folder + models["ResourcesMaterial"]
    for sk, name in (sections.get("Submodels") or {}).items():
        if not sk.lower().startswith("submodel"):
            continue
        sec = sections.get(name) or {}
        mesh, mat = sec.get("Mesh"), sec.get("Material")
        if not mesh or not mat:
            continue
        mf = _slash(sec.get("ResourcesMaterialFolder") or mat_folder)
        assign[mesh] = mf + mat
    return folder + root, assign


def model_keys(match):
    grouped = {}
    for folder in ("vessels", "aircraft", "land_units"):
        d = SRC / folder
        if not d.exists():
            continue
        for p in d.glob("*.ini"):
            if p.name.endswith("_variants.ini"):
                continue
            key, assign = read_model(p)
            if not key:
                continue
            if match and not any(m.lower() in key.lower() or m.lower() in p.stem.lower() for m in match):
                continue
            grouped.setdefault(key, []).append((p.stem, assign))
    chosen = {}
    for key, items in grouped.items():
        stem, assign = items[0]
        for s, a in items:
            if s in key:
                stem, assign = s, a
                break
        chosen[key] = (stem, assign)
    return chosen


def eye():
    return [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]


def matmul(a, b):
    c = [[0] * 4 for _ in range(4)]
    for i in range(4):
        for j in range(4):
            c[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j] + a[i][3] * b[3][j]
    return c


def trs(px, py, pz, qx, qy, qz, qw, sx, sy, sz):
    x, y, z, w = qx, qy, qz, qw
    xx, yy, zz = x * x, y * y, z * z
    xy, xz, yz = x * y, x * z, y * z
    wx, wy, wz = w * x, w * y, w * z
    r00, r01, r02 = 1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)
    r10, r11, r12 = 2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)
    r20, r21, r22 = 2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)
    return [
        [r00 * sx, r01 * sy, r02 * sz, px],
        [r10 * sx, r11 * sy, r12 * sz, py],
        [r20 * sx, r21 * sy, r22 * sz, pz],
        [0, 0, 0, 1],
    ]


def apply(m, x, y, z):
    return (
        m[0][0] * x + m[0][1] * y + m[0][2] * z + m[0][3],
        m[1][0] * x + m[1][1] * y + m[1][2] * z + m[1][3],
        m[2][0] * x + m[2][1] * y + m[2][2] * z + m[2][3],
    )


def apply_dir(m, x, y, z):
    return (
        m[0][0] * x + m[0][1] * y + m[0][2] * z,
        m[1][0] * x + m[1][1] * y + m[1][2] * z,
        m[2][0] * x + m[2][1] * y + m[2][2] * z,
    )


def norm(x, y, z):
    L = (x * x + y * y + z * z) ** 0.5
    if L < 1e-8:
        return 0.0, 1.0, 0.0
    return x / L, y / L, z / L


def comp_pptr(comp):
    if isinstance(comp, tuple):
        return comp[1]
    return getattr(comp, "component", None)


def parse_pptr(pptr):
    if not pptr:
        return None
    try:
        return pptr.deref_parse_as_object()
    except Exception:
        return None


def go_components(go):
    out = []
    for comp in go.m_Component or []:
        obj = parse_pptr(comp_pptr(comp))
        if obj is not None:
            out.append(obj)
    return out


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


class Glb:
    def __init__(self):
        self.bin = bytearray()
        self.views = []
        self.accessors = []
        self.materials = []
        self.textures = []
        self.images = []
        self.prims = []
        self._png = {}

    def _blob(self, data, target=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        off = len(self.bin)
        self.bin += data
        view = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
        if target:
            view["target"] = target
        self.views.append(view)
        return len(self.views) - 1

    def _acc(self, data, ctype, count, typ, target, mn=None, mx=None):
        i = self._blob(data, target)
        acc = {"bufferView": i, "componentType": ctype, "count": count, "type": typ}
        if mn is not None:
            acc["min"] = mn
            acc["max"] = mx
        self.accessors.append(acc)
        return len(self.accessors) - 1

    def material(self, color, png):
        pbr = {
            "baseColorFactor": [srgb_to_linear(color[0]), srgb_to_linear(color[1]), srgb_to_linear(color[2]), color[3]],
            "metallicFactor": 0.12,
            "roughnessFactor": 0.72,
        }
        if png:
            if png not in self._png:
                view = self._blob(png)
                self.images.append({"bufferView": view, "mimeType": "image/png"})
                self.textures.append({"sampler": 0, "source": len(self.images) - 1})
                self._png[png] = len(self.textures) - 1
            pbr["baseColorTexture"] = {"index": self._png[png]}
        self.materials.append({"doubleSided": True, "pbrMetallicRoughness": pbr})
        return len(self.materials) - 1

    def add_prim(self, positions, normals, uvs, indices, color, png):
        if len(indices) < 3:
            return
        pos = struct.pack("<" + "f" * (len(positions) * 3), *[c for p in positions for c in p])
        nrm = struct.pack("<" + "f" * (len(normals) * 3), *[c for p in normals for c in p])
        xs, ys, zs = zip(*positions)
        pa = self._acc(pos, 5126, len(positions), "VEC3", 34962, [min(xs), min(ys), min(zs)], [max(xs), max(ys), max(zs)])
        na = self._acc(nrm, 5126, len(normals), "VEC3", 34962)
        attrs = {"POSITION": pa, "NORMAL": na}
        if uvs:
            uv = struct.pack("<" + "f" * (len(uvs) * 2), *[c for p in uvs for c in p])
            attrs["TEXCOORD_0"] = self._acc(uv, 5126, len(uvs), "VEC2", 34962)
        if max(indices) > 65535:
            ib = struct.pack("<" + "I" * len(indices), *indices)
            ia = self._acc(ib, 5125, len(indices), "SCALAR", 34963)
        else:
            ib = struct.pack("<" + "H" * len(indices), *indices)
            ia = self._acc(ib, 5123, len(indices), "SCALAR", 34963)
        self.prims.append({"attributes": attrs, "indices": ia, "material": self.material(color, png)})

    def save(self, path):
        gltf = {
            "asset": {"version": "2.0", "generator": "sea_power extract_models"},
            "scene": 0,
            "scenes": [{"nodes": [0]}],
            "nodes": [{"name": "ship", "mesh": 0}],
            "meshes": [{"primitives": self.prims}],
            "materials": self.materials,
            "accessors": self.accessors,
            "bufferViews": self.views,
        }
        if self.images:
            gltf["images"] = self.images
            gltf["textures"] = self.textures
            gltf["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}]
        js = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
        while len(js) % 4:
            js += b" "
        blob = bytes(self.bin)
        while len(blob) % 4:
            blob += b"\x00"
        gltf["buffers"] = [{"byteLength": len(blob)}]
        # rebuild json now that buffer length is known
        js = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
        while len(js) % 4:
            js += b" "
        total = 12 + 8 + len(js) + 8 + len(blob)
        out = struct.pack("<III", 0x46546C67, 2, total)
        out += struct.pack("<I", len(js)) + b"JSON" + js
        out += struct.pack("<I", len(blob)) + b"BIN\x00" + blob
        path.write_bytes(out)


def prop_map(pairs):
    out = {}
    for k, v in pairs or []:
        if v is None:
            continue
        name = k if isinstance(k, str) else getattr(k, "name", str(k))
        out[name] = v
    return out


def color_tuple(col, fallback=(0.75, 0.78, 0.8, 1.0)):
    if col is None:
        return fallback
    if hasattr(col, "r"):
        return (float(col.r), float(col.g), float(col.b), float(getattr(col, "a", 1.0)))
    return (float(col[0]), float(col[1]), float(col[2]), float(col[3]) if len(col) > 3 else 1.0)


def material_look(mat):
    color = (0.75, 0.78, 0.8, 1.0)
    png = None
    if mat is None:
        return color, png
    saved = getattr(mat, "m_SavedProperties", None)
    if saved is None:
        return color, png
    colors = prop_map(saved.m_Colors)
    col = colors.get("_Color") or colors.get("_BaseColor")
    if col is not None:
        color = color_tuple(col, color)
    tex_envs = prop_map(saved.m_TexEnvs)
    env = tex_envs.get("_MainTex") or tex_envs.get("_BaseMap") or tex_envs.get("_BaseColorMap")
    if env is not None and getattr(env, "m_Texture", None):
        tex = parse_pptr(env.m_Texture)
        if tex is not None:
            try:
                img = tex.image
                if img is not None:
                    img = img.convert("RGBA")
                    img.thumbnail((2048, 2048))
                    buf = BytesIO()
                    img.save(buf, format="PNG", optimize=True)
                    png = buf.getvalue()
            except Exception as e:
                print("  texture skip", getattr(tex, "m_Name", "?"), e)
    return color, png


def mesh_prims(mesh, mat, world):
    handler = MeshHandler(mesh)
    handler.process()
    if not handler.m_Vertices:
        return []
    verts = handler.m_Vertices
    normals = handler.m_Normals
    uvs = handler.m_UV0
    color, png = mat
    prims = []
    for si, tris in enumerate(handler.get_triangles()):
        if not tris:
            continue
        # unique verts used by this submesh, Unity LH -> glTF RH (negate X) and reverse winding
        remap = {}
        pos, nrm, uv, idx = [], [], [], []
        for a, b, c in tris:
            for vi in (c, b, a):
                if vi not in remap:
                    remap[vi] = len(pos)
                    x, y, z = apply(world, *verts[vi])
                    pos.append((-x, y, z))
                    if normals and vi < len(normals):
                        nx, ny, nz = normals[vi][:3]
                        nx, ny, nz = apply_dir(world, nx, ny, nz)
                        nrm.append(norm(-nx, ny, nz))
                    else:
                        nrm.append((0, 1, 0))
                    if uvs and vi < len(uvs):
                        uv.append((float(uvs[vi][0]), float(uvs[vi][1])))
                idx.append(remap[vi])
        prims.append((pos, nrm, uv if uvs else None, idx, color, png))
    return prims


def export_gameobject(go, dest, assign, lookup):
    glb = Glb()
    looks = {}

    def look(mesh_name):
        path = assign.get(mesh_name) if assign else ""
        if not path:
            return None
        if path not in looks:
            hit = lookup.get(path.lower())
            material = parse_pptr(hit[1]) if hit else None
            if material is None:
                print("  no material", path)
            looks[path] = material_look(material)
        return looks[path]

    def walk(transform, parent, honor_active):
        local = trs(
            transform.m_LocalPosition.x, transform.m_LocalPosition.y, transform.m_LocalPosition.z,
            transform.m_LocalRotation.x, transform.m_LocalRotation.y, transform.m_LocalRotation.z, transform.m_LocalRotation.w,
            transform.m_LocalScale.x, transform.m_LocalScale.y, transform.m_LocalScale.z,
        )
        world = matmul(parent, local)
        go = parse_pptr(transform.m_GameObject)
        if go is None:
            return
        if honor_active and not go.m_IsActive:
            return
        # Damage and lower LOD meshes are separate objects and would z-fight the intact hull.
        gname = (go.m_Name or "").lower()
        if "_lod" in gname or gname.endswith("_d") or "_d_" in gname:
            return
        renderer = None
        mesh = None
        for c in go_components(go):
            name = type(c).__name__
            if name in ("MeshRenderer", "SkinnedMeshRenderer") and getattr(c, "m_Enabled", True):
                renderer = c
            if name == "MeshFilter" and getattr(c, "m_Mesh", None):
                mesh = parse_pptr(c.m_Mesh)
            if name == "SkinnedMeshRenderer" and getattr(c, "m_Mesh", None):
                mesh = parse_pptr(c.m_Mesh)
        if mesh is not None and renderer is not None:
            looked = look(mesh.m_Name)
            if looked is not None:
                try:
                    for prim in mesh_prims(mesh, looked, world):
                        glb.add_prim(*prim)
                except Exception as e:
                    print("  mesh skip", getattr(mesh, "m_Name", "?"), e)
        for child in transform.m_Children or []:
            ct = parse_pptr(child)
            if ct is not None:
                walk(ct, world, honor_active)

    transform = None
    for c in go_components(go):
        if type(c).__name__ in ("Transform", "RectTransform"):
            transform = c
            break
    if transform is None:
        raise RuntimeError("no transform on " + go.m_Name)
    walk(transform, eye(), True)
    if not glb.prims:
        walk(transform, eye(), False)
    if not glb.prims:
        raise RuntimeError("no meshes on " + go.m_Name)
    glb.save(dest)
    n = sum(p["attributes"]["POSITION"] is not None for p in glb.prims)
    return len(glb.prims), n


def safe_file(key):
    name = key.replace("\\", "/").strip("/").replace("/", "__")
    for ch in '<>:"|?*':
        name = name.replace(ch, "_")
    return name + ".glb"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--match", nargs="*", default=[])
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--keys-only", action="store_true")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    keys = model_keys(args.match)
    print(f"{len(keys)} resource keys", flush=True)
    if args.keys_only:
        for k, (stem, assign) in list(keys.items())[:30]:
            print(stem, len(assign), "->", k)
        return
    if not ASSETS.exists():
        sys.exit("missing " + str(ASSETS))
    OUT.mkdir(parents=True, exist_ok=True)
    print("loading ResourceManager + resources.assets", flush=True)
    env = UnityPy.Environment(path=str(DATA))
    env.load_file(str(MANAGERS))
    env.load_file(str(ASSETS))
    # Vertex and texture bytes live in the streamed resource next to resources.assets.
    for extra in ("resources.assets.resS", "resources.resource"):
        ep = DATA / extra
        if ep.exists():
            env.load_file(str(ep))
    # Prefab paths are on ResourceManager in globalgamemanagers, not an AssetBundle.
    lookup = {}
    for obj in env.objects:
        if obj.type.name != "ResourceManager":
            continue
        rm = obj.read()
        for path, pptr in rm.m_Container:
            norm = path.replace("\\", "/").lstrip("/")
            lookup.setdefault(norm.lower(), (norm, pptr))
    print(f"resource paths {len(lookup)}", flush=True)
    done = 0
    index_path = OUT / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {}
    for key, (stem, assign) in keys.items():
        if args.limit and done >= args.limit:
            break
        dest = OUT / safe_file(key)
        if dest.exists() and dest.stat().st_size > 0 and not args.force:
            print("keep", dest.name, flush=True)
            index[key] = {"file": dest.name, "source": stem}
            done += 1
            continue
        hit = lookup.get(key.lower())
        if hit is None:
            print("MISSING", key, flush=True)
            continue
        _norm, pptr = hit
        try:
            obj = pptr.deref()
        except Exception as e:
            print("deref fail", key, e, flush=True)
            continue
        if obj.type.name != "GameObject":
            print("not a prefab", key, obj.type.name, flush=True)
            continue
        go = pptr.deref_parse_as_object()
        print("export", stem, key, flush=True)
        try:
            nprim, _ = export_gameobject(go, dest, assign, lookup)
        except Exception as e:
            print("  FAIL", e, flush=True)
            continue
        print(f"  {dest.name} {dest.stat().st_size/1e6:.1f} MB  {nprim} parts", flush=True)
        index[key] = {"file": dest.name, "source": stem, "bytes": dest.stat().st_size}
        index_path.write_text(json.dumps(index), encoding="utf-8")
        done += 1
    print("exported", done, flush=True)


if __name__ == "__main__":
    main()
