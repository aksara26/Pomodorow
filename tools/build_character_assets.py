#!/usr/bin/env python3
"""Build the transparent character layers from the existing portrait.

The original PNGs are never modified.  Everything written here lives in
images/character/ and keeps the 400x400 canvas so every layer can be stacked
without per-asset offsets.

Run from the repository root:
    python3 tools/build_character_assets.py
"""

from pathlib import Path
import math

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "images" / "normal.png"
HAPPY = ROOT / "images" / "happy.png"
OUT = ROOT / "images" / "character"
W = H = 400
S = 4  # supersampling for the small hand-drawn features
EYE_SCALE = 0.78  # sockets were too large for a believable face


EYES = {
    "left": {
        "center": (197.5, 96.0),
        "iris": (197.5, 96.0, 8.3, 6.7),
        "sclera": (250, 247, 243),
        "skin": (253, 213, 193),
        "lash": (42, 34, 45),
        # Bigger, rounder anime socket: more room for the iris to travel.
        "almond": [
            (179.5, 95.0), (181.0, 90.8), (185.5, 87.2), (191.5, 84.7),
            (198.0, 83.8), (205.5, 85.0), (211.5, 88.0), (215.0, 92.0),
            (215.5, 96.5), (213.0, 101.2), (207.5, 105.0), (200.0, 108.0),
            (192.5, 108.2), (186.0, 104.8), (181.0, 100.5),
        ],
    },
    "right": {
        "center": (249.5, 109.5),
        "iris": (249.5, 109.5, 8.3, 6.7),
        "sclera": (252, 249, 245),
        "skin": (252, 210, 190),
        "lash": (42, 34, 45),
        "almond": [
            (232.5, 108.5), (234.0, 104.0), (238.5, 100.4), (244.5, 97.8),
            (251.0, 96.8), (258.5, 98.0), (264.5, 101.2), (267.0, 105.2),
            (267.0, 110.0), (264.5, 115.0), (258.5, 119.0), (251.0, 121.8),
            (243.5, 122.0), (236.8, 118.6), (232.4, 113.8),
        ],
    },
}


def ellipse_mask(center, radii, feather=0.0):
    mask = Image.new("L", (W, H), 0)
    draw = ImageDraw.Draw(mask)
    cx, cy, rx, ry = center[0], center[1], radii[0], radii[1]
    draw.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=255)
    if feather:
        mask = mask.filter(ImageFilter.GaussianBlur(feather))
    return mask


def alpha_canvas():
    return Image.new("RGBA", (W, H), (0, 0, 0, 0))


def diffuse_fill(image, mask, radius=4, iterations=12):
    """Cheap inpainting: diffuse the boundary colours into the masked area."""
    ring = mask.filter(ImageFilter.MaxFilter(15))
    # Initial colour: average of the visible pixels in the surrounding ring.
    total = [0, 0, 0, 0]
    count = 0
    px, rp, mp = image.load(), ring.load(), mask.load()
    for y in range(120, 160):
        for x in range(196, 248):
            if rp[x, y] > 0 and mp[x, y] < 10:
                c = px[x, y]
                for i in range(4):
                    total[i] += c[i]
                count += 1
    if count:
        avg = tuple(v // count for v in total)
        work = Image.composite(Image.new("RGBA", (W, H), avg), image, mask)
        for _ in range(iterations):
            blurred = work.filter(ImageFilter.GaussianBlur(radius))
            work = Image.composite(blurred, work, mask)
        return work
    return image


def remove_background(img, bg_color_tolerance=30):
    """Remove solid background color (assumes corners are background).
    Preserves existing transparency."""
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    
    # If corners are already transparent, don't do background removal
    corners = [(0, 0), (w-1, 0), (0, h-1), (w-1, h-1)]
    corner_alphas = [px[x, y][3] for x, y in corners]
    if all(a == 0 for a in corner_alphas):
        return img  # Already has transparency
    
    # Sample corner colors to detect background (only opaque corners)
    corner_colors = []
    for x, y in corners:
        r, g, b, a = px[x, y]
        if a > 128:  # Only consider opaque corners
            corner_colors.append((r, g, b))
    
    if not corner_colors:
        return img
    
    # Use most common corner color as background
    from collections import Counter
    bg_color = Counter(corner_colors).most_common(1)[0][0]
    
    # Create mask: transparent where color matches background
    mask = Image.new("L", (w, h), 255)
    mp = mask.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a > 0:
                dr, dg, db = r - bg_color[0], g - bg_color[1], b - bg_color[2]
                if dr*dr + dg*dg + db*db <= bg_color_tolerance**2:
                    mp[x, y] = 0
    img.putalpha(mask)
    return img


def make_clean_portrait(src):
    """Remove the irises and mouth so they can be animated as layers."""
    # First, remove solid background if present
    clean = remove_background(src)
    
    # Eyes: the whole socket becomes eye white, then the lash frame is drawn
    # back on top. The irises live in their own layers above this.
    for eye in EYES.values():
        fill = Image.new("RGBA", (W, H), eye["sclera"] + (255,))
        mask = almond_mask(eye, blur=0.9)
        clean = Image.composite(fill, clean, mask)

    # Mouth: smooth skin patch.
    mouth_mask = ellipse_mask((222, 139.5), (18, 11.5), 2.0)
    clean = diffuse_fill(clean, mouth_mask)

    return clean


def almond_mask(eye, scale=1.0, dx=0.0, dy=0.0, blur=0.0, factor=1):
    cx, cy = eye["center"]
    s = EYE_SCALE * scale
    pts = [((cx + (x - cx) * s + dx) * factor,
            (cy + (y - cy) * s + dy * EYE_SCALE) * factor)
           for x, y in eye["almond"]]
    mask = Image.new("L", (W * factor, H * factor), 0)
    ImageDraw.Draw(mask).polygon(pts, fill=255)
    if blur:
        mask = mask.filter(ImageFilter.GaussianBlur(blur * factor))
    return mask


def eye_edges(eye):
    """Top/bottom socket edge for every column, used to draw real eyelids."""
    mask = almond_mask(eye, blur=0.8).load()
    ys = [p[1] for p in eye["almond"]]
    xs = [p[0] for p in eye["almond"]]
    edges = {}
    for x in range(int(min(xs)) - 1, int(max(xs)) + 2):
        top = bottom = None
        for y in range(int(min(ys)) - 3, int(max(ys)) + 4):
            if mask[x, y] > 60:
                if top is None:
                    top = y
                bottom = y
        if top is not None:
            edges[x] = (top, bottom)
    return edges


def _boundary(edges, frac):
    pts = []
    for x in sorted(edges):
        top, bottom = edges[x]
        pts.append((x, top + (bottom - top) * frac))
    return pts


def _fill_above(almond, pts):
    poly = list(pts) + [(pts[-1][0], 0), (pts[0][0], 0)]
    above = Image.new("L", (W, H), 0)
    ImageDraw.Draw(above).polygon(poly, fill=255)
    return ImageChops.multiply(almond, above)


def mix3(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def make_iris(eye):
    """Iris with a limbal ring, blue-grey depth and a large pupil."""
    cx, cy, rx, ry = eye["iris"]
    sw, sh = 44, 36
    img = Image.new("RGBA", (sw * S, sh * S), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    ccx, ccy = sw * S / 2, sh * S / 2
    RX, RY = rx * S, ry * S
    outer = (ccx - RX, ccy - RY, ccx + RX, ccy + RY)

    draw.ellipse(outer, fill=(18, 26, 42, 255))

    inset = 0.55 * S
    iris_mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(iris_mask).ellipse(
        (ccx - RX + inset, ccy - RY + inset, ccx + RX - inset, ccy + RY - inset),
        fill=255)

    grad = Image.new("RGBA", img.size, (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(grad)
    steps = 32
    for i in range(steps):
        t = (i / (steps - 1)) ** 1.25
        col = mix3((26, 40, 62), (104, 146, 182), t)
        gdraw.rectangle((ccx - RX, ccy - RY + 2 * RY * i / steps,
                         ccx + RX, ccy - RY + 2 * RY * (i + 1) / steps + 1),
                        fill=col + (255,))
    img.paste(grad, (0, 0), iris_mask)

    # Subtle radial fibres: they add depth without noise at 1x.
    for i in range(12):
        a = 2 * math.pi * i / 12 + 0.18
        draw.line([(ccx + math.cos(a) * 4.9 * S, ccy + math.sin(a) * 4.7 * S),
                   (ccx + math.cos(a) * (RX - 1.3 * S),
                    ccy + math.sin(a) * (RY - 1.1 * S))],
                  fill=(150, 186, 214, 55), width=max(1, int(0.45 * S)))

    # Large pupil: this is what the eye reads as at 230 px.
    draw.ellipse((ccx - 4.6 * S, ccy - 4.3 * S, ccx + 4.6 * S, ccy + 4.5 * S),
                 fill=(9, 10, 14, 255))
    draw.ellipse((ccx - 3.4 * S, ccy - 3.3 * S, ccx + 3.4 * S, ccy + 3.5 * S),
                 fill=(3, 4, 6, 255))
    draw.arc((ccx - RX * 0.72, ccy + RY * 0.05,
              ccx + RX * 0.72, ccy + RY * 1.28),
             18, 162, fill=(168, 202, 228, 120), width=max(1, int(0.85 * S)))
    draw.ellipse((ccx - 3.9 * S, ccy - 4.2 * S, ccx - 1.3 * S, ccy - 1.7 * S),
                 fill=(255, 255, 255, 235))
    draw.ellipse((ccx + 1.8 * S, ccy + 0.2 * S, ccx + 3.0 * S, ccy + 1.4 * S),
                 fill=(255, 255, 255, 120))
    draw.ellipse(outer, outline=(12, 16, 24, 210), width=max(1, int(0.5 * S)))

    img = img.resize((sw, sh), Image.LANCZOS)
    layer = alpha_canvas()
    layer.alpha_composite(img, (round(cx - sw / 2), round(cy - sh / 2)))
    return layer


def make_eye_frame(with_shadow=True):
    """Lash ring drawn above the irises so they can travel without spilling."""
    layer = alpha_canvas()
    for eye in EYES.values():
        outer = almond_mask(eye, blur=0.9)
        inner = almond_mask(eye, scale=0.87, dy=1.3, blur=0.7)
        ring = ImageChops.subtract(outer, inner)
        layer.alpha_composite(solid_layer(eye["lash"], ring))

        if with_shadow:
            band = ImageChops.subtract(
                almond_mask(eye, scale=0.99, blur=1.0),
                almond_mask(eye, scale=0.80, dy=2.6, blur=1.0))
            band = band.point(lambda v: int(v * 0.40))
            layer.alpha_composite(solid_layer((36, 48, 66), band))
    return layer


def _smooth(pts, passes=3):
    """Average a point list so hand-placed boundary samples draw as a curve."""
    for _ in range(passes):
        if len(pts) < 3:
            return pts
        out = [pts[0]]
        for i in range(1, len(pts) - 1):
            out.append(((pts[i - 1][0] + 2 * pts[i][0] + pts[i + 1][0]) / 4,
                        (pts[i - 1][1] + 2 * pts[i][1] + pts[i + 1][1]) / 4))
        out.append(pts[-1])
        pts = out
    return pts


def solid_layer(color, mask):
    """Opaque colour masked by `mask`, avoiding dark fringes at soft edges.

    Image.composite() blends the RGB channels towards the transparent canvas
    as well, so a blurred mask leaves a dark halo around the shape. Building
    the colour first and only replacing the alpha keeps the edge clean.
    """
    layer = Image.new("RGBA", (W, H), tuple(color[:3]) + (255,))
    layer.putalpha(mask)
    return layer


def draw_lid(eye, kind, edges):
    """Draw one eyelid frame at 4x, then downsample so the lash line is smooth."""
    L = 4
    lash = eye["lash"] + (255,)
    almond = almond_mask(eye, blur=0.9, factor=L)

    def P(pts):
        return [(x * L, y * L) for x, y in pts]

    def fill_above(pts):
        poly = list(pts) + [(pts[-1][0], 0), (pts[0][0], 0)]
        above = Image.new("L", almond.size, 0)
        ImageDraw.Draw(above).polygon(poly, fill=255)
        return ImageChops.multiply(almond, above)

    def solid(color, mask):
        layer = Image.new("RGBA", almond.size, tuple(color[:3]) + (255,))
        layer.putalpha(mask)
        return layer

    def finish(layer):
        return layer.resize((W, H), Image.LANCZOS)

    if kind == "happy":
        xs = sorted(edges)
        pts = []
        for x in xs:
            top, bottom = edges[x]
            h = bottom - top
            t = (x - xs[0]) / max(1, xs[-1] - xs[0])
            pts.append((x, bottom - h * (0.30 + 0.32 * math.sin(math.pi * t))))
        layer = solid(eye["skin"], almond)
        ImageDraw.Draw(layer).line(P(_smooth(pts)), fill=lash, width=3 * L, joint="curve")
        return finish(layer)

    if kind == "closed":
        # At the rendered size the socket is only ~17 px wide, so two dark
        # lines plus corner flicks read as a smudge. Keep it to a skin patch
        # that matches the face, a soft upper-lid shade and one lash curve.
        lid_skin = mix3(eye["skin"], (236, 188, 174), 0.25)
        lid_mask = almond_mask(eye, scale=1.10, blur=1.4, factor=L)
        layer = solid(lid_skin, lid_mask)

        pts = _boundary(edges, 0.58)
        ys = [p[1] for p in pts]
        y0 = sum(ys) / len(ys)
        p0 = ((pts[0][0] + 3.0) * L, y0 * L)
        p2 = ((pts[-1][0] - 3.0) * L, y0 * L)
        ctrl = ((p0[0] + p2[0]) / 2, (y0 + 1.6) * L)
        lash_line = [
            ((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * ctrl[0] + t ** 2 * p2[0],
             (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * ctrl[1] + t ** 2 * p2[1])
            for t in (i / 24 for i in range(25))
        ]

        above = fill_above(lash_line).filter(ImageFilter.GaussianBlur(1.6 * L))
        above = above.point(lambda v: int(v * 0.18))
        layer = Image.alpha_composite(layer, solid((208, 158, 148), above))

        ImageDraw.Draw(layer).line(lash_line, fill=lash, width=2 * L, joint="curve")
        return finish(layer)

    frac = {"quarter": 0.34, "half": 0.60, "three-quarter": 0.78}[kind]
    pts = _smooth(_boundary(edges, frac))
    layer = solid(eye["skin"], fill_above(P(pts)))
    shade = almond.point(lambda v: int(v * 0.12))
    layer = Image.alpha_composite(layer, solid((214, 160, 146), shade))
    ImageDraw.Draw(layer).line(P(pts), fill=lash, width=2 * L, joint="curve")
    return finish(layer)


LIP = (214, 92, 104, 255)
LIP2 = (238, 128, 132, 255)
LIP3 = (255, 180, 170, 255)
DARK = (110, 45, 60, 255)
TONGUE = (240, 120, 130, 255)


def mouth_sprite(draw_fn, width=32, height=22):
    image = Image.new("RGBA", (width * S, height * S), (0, 0, 0, 0))
    draw_fn(ImageDraw.Draw(image), S)
    return image.resize((width, height), Image.LANCZOS)


def mouths():
    def neutral(d, s):
        d.line([(8 * s, 11 * s), (13 * s, 12 * s), (19 * s, 12 * s), (24 * s, 10 * s)],
               fill=LIP, width=2 * s, joint="curve")
        d.line([(10 * s, 9 * s), (16 * s, 10 * s), (23 * s, 9 * s)],
               fill=LIP3, width=1 * s)

    def smile(d, s):
        d.line([(7 * s, 9 * s), (12 * s, 12 * s), (18 * s, 13 * s), (25 * s, 9 * s)],
               fill=LIP, width=2 * s, joint="curve")
        d.line([(8 * s, 8 * s), (16 * s, 10 * s), (24 * s, 8 * s)],
               fill=LIP3, width=1 * s)
        d.arc((11 * s, 10 * s, 21 * s, 16 * s), 0, 180, fill=LIP2, width=1 * s)

    def open_mouth(d, s):
        d.ellipse((9 * s, 6 * s, 23 * s, 17 * s), fill=DARK)
        d.ellipse((10 * s, 7 * s, 22 * s, 12 * s), fill=(255, 255, 255, 255))
        d.ellipse((11 * s, 10 * s, 21 * s, 16 * s), fill=TONGUE)
        d.arc((9 * s, 6 * s, 23 * s, 17 * s), 0, 360, fill=LIP, width=2 * s)

    def laugh(d, s):
        d.ellipse((7 * s, 5 * s, 25 * s, 18 * s), fill=DARK)
        d.ellipse((9 * s, 6 * s, 23 * s, 11 * s), fill=(255, 255, 255, 255))
        d.ellipse((11 * s, 11 * s, 21 * s, 17 * s), fill=TONGUE)
        d.arc((7 * s, 5 * s, 25 * s, 18 * s), 0, 360, fill=LIP, width=2 * s)

    def pout(d, s):
        d.ellipse((11 * s, 9 * s, 21 * s, 15 * s), fill=LIP2)
        d.line([(13 * s, 11 * s), (19 * s, 11 * s)], fill=LIP, width=2 * s)
        d.line([(14 * s, 7 * s), (18 * s, 7 * s)], fill=LIP3, width=1 * s)

    def yawn(d, s):
        d.ellipse((9 * s, 3 * s, 23 * s, 19 * s), fill=DARK)
        d.ellipse((12 * s, 12 * s, 20 * s, 18 * s), fill=TONGUE)
        d.arc((9 * s, 3 * s, 23 * s, 19 * s), 0, 360, fill=LIP, width=2 * s)

    def oh(d, s):
        d.ellipse((12 * s, 7 * s, 20 * s, 15 * s), fill=DARK)
        d.arc((12 * s, 7 * s, 20 * s, 15 * s), 0, 360, fill=LIP, width=2 * s)

    def frown(d, s):
        d.line([(8 * s, 12 * s), (13 * s, 9 * s), (19 * s, 9 * s), (24 * s, 12 * s)],
               fill=LIP, width=2 * s, joint="curve")

    def smirk(d, s):
        d.line([(9 * s, 11 * s), (16 * s, 12 * s), (23 * s, 8 * s)],
               fill=LIP, width=2 * s, joint="curve")

    def determined(d, s):
        d.line([(9 * s, 11 * s), (16 * s, 11 * s), (23 * s, 11 * s)],
               fill=LIP, width=2 * s)
        d.line([(11 * s, 9 * s), (21 * s, 9 * s)], fill=LIP3, width=1 * s)

    return {
        "neutral": neutral,
        "smile": smile,
        "open": open_mouth,
        "laugh": laugh,
        "pout": pout,
        "yawn": yawn,
        "o": oh,
        "frown": frown,
        "smirk": smirk,
        "determined": determined,
    }


def write_mouths():
    for name, fn in mouths().items():
        sprite = mouth_sprite(fn)
        layer = alpha_canvas()
        layer.alpha_composite(sprite, (205, 128))
        layer.save(OUT / f"mouth_{name}.png")


def make_blush():
    layer = alpha_canvas()
    draw = ImageDraw.Draw(layer)
    draw.ellipse((188, 104, 220, 122), fill=(255, 128, 150, 92))
    draw.ellipse((242, 114, 274, 132), fill=(255, 128, 150, 92))
    layer = layer.filter(ImageFilter.GaussianBlur(7))
    layer.save(OUT / "blush.png")


def make_brows():
    """Small, asymmetric brow assets for stronger expressions."""
    brow = (44, 67, 104, 255)
    for name in ("neutral", "angry", "shy", "confused"):
        layer = alpha_canvas()
        draw = ImageDraw.Draw(layer)
        if name == "angry":
            draw.line([(181, 79), (198, 76), (214, 80)], fill=brow, width=3, joint="curve")
            draw.line([(233, 91), (251, 86), (266, 90)], fill=brow, width=3, joint="curve")
        elif name == "shy":
            draw.arc((178, 67, 216, 88), 190, 350, fill=brow, width=3)
            draw.arc((232, 80, 267, 101), 190, 350, fill=brow, width=3)
        elif name == "confused":
            draw.arc((178, 68, 216, 90), 190, 350, fill=brow, width=3)
            draw.line([(233, 91), (249, 87), (265, 91)], fill=brow, width=3, joint="curve")
        else:
            draw.arc((178, 68, 216, 89), 190, 350, fill=brow, width=2)
            draw.arc((232, 82, 267, 103), 190, 350, fill=brow, width=2)
        layer.save(OUT / f"brow_{name}.png")


def make_hearts():
    happy = Image.open(HAPPY).convert("RGBA")
    layer = alpha_canvas()
    for box in ((0, 0, 80, 75), (290, 0, 400, 100)):
        layer.alpha_composite(happy.crop(box), (box[0], box[1]))
    layer.save(OUT / "hearts.png")


def make_accessories():
    size = (W * S, H * S)
    dark = (116, 48, 70, 255)
    pink = (246, 116, 158, 255)
    light_pink = (255, 190, 207, 255)

    bow = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(bow)
    d.polygon([(275*S, 60*S), (260*S, 49*S), (255*S, 53*S), (258*S, 64*S),
               (271*S, 66*S)], fill=pink, outline=dark, width=2*S)
    d.polygon([(276*S, 60*S), (290*S, 49*S), (296*S, 53*S), (292*S, 64*S),
               (280*S, 66*S)], fill=pink, outline=dark, width=2*S)
    d.ellipse((269*S, 56*S, 281*S, 67*S), fill=light_pink, outline=dark, width=2*S)
    d.ellipse((261*S, 53*S, 265*S, 56*S), fill=(255, 235, 239, 255))
    bow = bow.resize((W, H), Image.LANCZOS)
    bow.save(OUT / "accessory_bow.png")

    flower = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(flower)
    cx, cy = 280*S, 59*S
    for angle in range(0, 360, 60):
        x = cx + round(math.cos(math.radians(angle)) * 8*S)
        y = cy + round(math.sin(math.radians(angle)) * 8*S)
        d.ellipse((x - 6*S, y - 6*S, x + 6*S, y + 6*S),
                  fill=light_pink, outline=dark, width=1*S)
    d.ellipse((cx - 5*S, cy - 5*S, cx + 5*S, cy + 5*S),
              fill=(255, 219, 112, 255), outline=dark, width=1*S)
    d.ellipse((cx - 2*S, cy - 3*S, cx + 1*S, cy),
              fill=(255, 247, 203, 255))
    flower = flower.resize((W, H), Image.LANCZOS)
    flower.save(OUT / "accessory_flower.png")


def compose(clean_head, clean_body, mouth, lid, iris_offset=(0, 0),
            blush=False, hearts=False, brow="neutral", accessory=None):
    out = alpha_canvas()
    out.alpha_composite(clean_body)
    out.alpha_composite(clean_head)
    out.alpha_composite(Image.open(OUT / f"brow_{brow}.png"))
    if blush:
        out.alpha_composite(Image.open(OUT / "blush.png"))
    out.alpha_composite(Image.open(OUT / f"mouth_{mouth}.png"))
    for side in ("left", "right"):
        iris = Image.open(OUT / f"iris_{side}.png")
        shifted = alpha_canvas()
        shifted.alpha_composite(iris, iris_offset)
        out.alpha_composite(shifted)
    frame = OUT / "eye_frame.png"
    if frame.exists():
        out.alpha_composite(Image.open(frame))
    if lid != "open":
        for side in ("left", "right"):
            out.alpha_composite(Image.open(OUT / f"lid_{side}_{lid}.png"))
    if accessory:
        out.alpha_composite(Image.open(OUT / f"accessory_{accessory}.png"))
    if hearts:
        out.alpha_composite(Image.open(OUT / "hearts.png"))
    return out


def previews(clean_head, clean_body):
    previews_dir = ROOT / "images" / "character" / "previews"
    previews_dir.mkdir(exist_ok=True)
    def save(name, **kwargs):
        img = compose(clean_head, clean_body, **kwargs)
        bg = Image.new("RGBA", (W, H), (235, 241, 250, 255))
        bg.alpha_composite(img)
        bg.resize((300, 300), Image.LANCZOS).save(previews_dir / f"{name}.png")
    save("neutral", mouth="neutral", lid="open")
    save("happy", mouth="smile", lid="open", blush=True, hearts=True)
    save("sleepy", mouth="yawn", lid="half", blush=True)
    save("laugh", mouth="laugh", lid="happy", blush=True, hearts=True)
    save("surprised", mouth="o", lid="open", iris_offset=(0, -2))
    save("focused", mouth="determined", lid="half", iris_offset=(0, 2))
    save("gaze-left", mouth="neutral", lid="open", iris_offset=(-5, 1))
    save("gaze-right", mouth="smile", lid="open", iris_offset=(5, 1))
    save("blink-quarter", mouth="neutral", lid="quarter")
    save("blink-closed", mouth="neutral", lid="closed")
    save("theme-bow", mouth="smile", lid="open", accessory="bow")
    save("theme-flower", mouth="smile", lid="open", accessory="flower")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    src = Image.open(SRC).convert("RGBA")
    clean = make_clean_portrait(src)

    # Head / body split with a soft overlap so small head tilts stay seamless.
    head_alpha = Image.new("L", (W, H), 0)
    body_alpha = Image.new("L", (W, H), 0)
    hp, bp = head_alpha.load(), body_alpha.load()
    for y in range(H):
        if y <= 170:
            ha = 255
        elif y < 200:
            ha = int(255 * (200 - y) / 30)
        else:
            ha = 0
        if y >= 175:
            ba = 255
        elif y > 150:
            ba = int(255 * (y - 150) / 25)
        else:
            ba = 0
        for x in range(W):
            hp[x, y] = ha
            bp[x, y] = ba

    clean_head = clean.copy()
    clean_head.putalpha(Image.composite(clean.getchannel("A"),
                                       Image.new("L", (W, H), 0), head_alpha))
    clean_body = clean.copy()
    clean_body.putalpha(Image.composite(clean.getchannel("A"),
                                       Image.new("L", (W, H), 0), body_alpha))
    clean_head.save(OUT / "head.png")
    clean_body.save(OUT / "body.png")

    for side, eye in EYES.items():
        edges = eye_edges(eye)
        make_iris(eye).save(OUT / f"iris_{side}.png")
        for kind in ("quarter", "half", "three-quarter", "closed", "happy"):
            draw_lid(eye, kind, edges).save(OUT / f"lid_{side}_{kind}.png")

    make_eye_frame().save(OUT / "eye_frame.png")

    write_mouths()
    make_blush()
    make_brows()
    make_hearts()
    make_accessories()
    previews(clean_head, clean_body)
    print(f"Wrote character layers to {OUT}")


if __name__ == "__main__":
    main()
