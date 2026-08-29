#!/usr/bin/env python3
"""Emit a solid, watertight STL of the Obelisk icon revolved into 3D.

Geometry comes straight from src/components/ObeliskIcon.tsx: a square-section
shaft that tapers from the base up to the shoulder, capped by a pyramidion.
The icon's silhouette half-widths are the *half-diagonal-free* face half-widths,
i.e. the profile is read as the width of a square face.

Usage: python3 obelisk_stl.py [out.stl] [height_mm]
"""
import struct
import sys

# --- Profile, in SVG viewBox units (from ObeliskIcon.tsx) -------------------
SVG_HEIGHT = 448.0          # y 16 -> 464
BASE_HALF = 111.22 / 2      # 55.61
SHOULDER_HALF = 71.42 / 2   # 35.71
SHOULDER_Y = 448.0 - 45.58  # 402.42 (pyramidion is the top 45.58)

# --- Options ---------------------------------------------------------------
OUT = sys.argv[1] if len(sys.argv) > 1 else "obelisk.stl"
HEIGHT_MM = float(sys.argv[2]) if len(sys.argv) > 2 else 100.0
S = HEIGHT_MM / SVG_HEIGHT   # uniform scale, viewBox units -> mm

h_base = BASE_HALF * S
h_shoulder = SHOULDER_HALF * S
z_shoulder = SHOULDER_Y * S
z_top = SVG_HEIGHT * S


def ring(half, z):
    """Corners of a square section, counter-clockwise seen from +Z."""
    return [(-half, -half, z), (half, -half, z), (half, half, z), (-half, half, z)]


base = ring(h_base, 0.0)
shoulder = ring(h_shoulder, z_shoulder)
apex = (0.0, 0.0, z_top)

tris = []

# Bottom cap (normal -Z, so wound clockwise seen from +Z)
b = base
tris += [(b[0], b[2], b[1]), (b[0], b[3], b[2])]

# Shaft walls: quad per side, split into two triangles
for i in range(4):
    j = (i + 1) % 4
    tris += [
        (base[i], base[j], shoulder[j]),
        (base[i], shoulder[j], shoulder[i]),
    ]

# Pyramidion
for i in range(4):
    j = (i + 1) % 4
    tris.append((shoulder[i], shoulder[j], apex))


def normal(t):
    (ax, ay, az), (bx, by, bz), (cx, cy, cz) = t
    ux, uy, uz = bx - ax, by - ay, bz - az
    vx, vy, vz = cx - ax, cy - ay, cz - az
    nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
    m = (nx * nx + ny * ny + nz * nz) ** 0.5 or 1.0
    return (nx / m, ny / m, nz / m)


with open(OUT, "wb") as f:
    f.write(b"Obelisk - obelisk-dex ObeliskIcon revolved".ljust(80, b"\0"))
    f.write(struct.pack("<I", len(tris)))
    for t in tris:
        f.write(struct.pack("<3f", *normal(t)))
        for v in t:
            f.write(struct.pack("<3f", *v))
        f.write(struct.pack("<H", 0))

print(f"{OUT}: {len(tris)} triangles")
print(f"  height     {z_top:.2f} mm")
print(f"  base       {2 * h_base:.2f} x {2 * h_base:.2f} mm")
print(f"  shoulder   {2 * h_shoulder:.2f} x {2 * h_shoulder:.2f} mm at z={z_shoulder:.2f}")
print(f"  pyramidion {z_top - z_shoulder:.2f} mm tall")
