"""Generuje ikony rozszerzenia (icons/icon-{16,32,48,128}.png).

Czysty Python (bez Pillow): rasteryzacja z nadpróbkowaniem + zapis PNG
przez zlib. Kształt odpowiada icons/icon.svg:
zaokrąglony kwadrat #1e1e1e i pomarańczowy półksiężyc #ff5a00.

Użycie:  python tools/make_icons.py
"""
import os
import struct
import zlib

BG = (0x1E, 0x1E, 0x1E)
ACCENT = (0xFF, 0x5A, 0x00)
SIZES = (16, 32, 48, 128)
SS = 8  # nadpróbkowanie na oś

# Geometria w układzie 0..128 (jak w icon.svg)
RADIUS = 28            # zaokrąglenie rogów tła
MOON_C = (64, 64)      # środek księżyca
MOON_R = 38
CUT_C = (82, 48)       # środek koła wycinającego
CUT_R = 32


def inside_rounded_rect(x, y):
    r = RADIUS
    cx = min(max(x, r), 128 - r)
    cy = min(max(y, r), 128 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def inside_moon(x, y):
    in_moon = (x - MOON_C[0]) ** 2 + (y - MOON_C[1]) ** 2 <= MOON_R ** 2
    in_cut = (x - CUT_C[0]) ** 2 + (y - CUT_C[1]) ** 2 <= CUT_R ** 2
    return in_moon and not in_cut


def render(size):
    scale = 128 / size
    rows = []
    for py in range(size):
        row = bytearray([0])  # filtr PNG: None
        for px in range(size):
            bg_hits = moon_hits = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) * scale
                    y = (py + (sy + 0.5) / SS) * scale
                    if inside_rounded_rect(x, y):
                        bg_hits += 1
                        if inside_moon(x, y):
                            moon_hits += 1
            total = SS * SS
            alpha = bg_hits / total
            if bg_hits:
                t = moon_hits / bg_hits
                color = [round(BG[i] * (1 - t) + ACCENT[i] * t) for i in range(3)]
            else:
                color = [0, 0, 0]
            row.extend(color + [round(alpha * 255)])
        rows.append(bytes(row))
    return b"".join(rows)


def png(size, raw):
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def main():
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
    os.makedirs(out_dir, exist_ok=True)
    for size in SIZES:
        path = os.path.join(out_dir, f"icon-{size}.png")
        with open(path, "wb") as f:
            f.write(png(size, render(size)))
        print("zapisano", os.path.normpath(path))


if __name__ == "__main__":
    main()
