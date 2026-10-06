# /// script
# requires-python = ">=3.11"
# dependencies = ["skia-python==144.0.post2", "pillow==12.3.0"]
# ///

"""Render platform assets from preserved vector masters; never rewrite originals.

Run: pnpm icons:app
"""

import io
import json
from copy import deepcopy
import xml.etree.ElementTree as ET
from pathlib import Path

import skia
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets/brand/source"
BRAND = ROOT / "assets/brand/generated"
BRAND.mkdir(parents=True, exist_ok=True)

SVG_NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG_NS)
mark = ET.parse(SOURCE / "mark.svg").getroot()
paths = mark.findall(f".//{{{SVG_NS}}}path")
if len(paths) != 2:
    raise ValueError("Twin Mind's master must contain exactly two contours")
MARK_VIEWBOX = [float(value) for value in mark.attrib["viewBox"].split()]
if MARK_VIEWBOX[2] <= 0 or MARK_VIEWBOX[2] != MARK_VIEWBOX[3]:
    raise ValueError("The mark master must have a positive square viewBox")
PALETTES = {
    "light": (paths[0].attrib["fill"], paths[1].attrib["fill"], "#24134f", "#f8f6fc"),
    "dark": ("#c5b4f4", "#a18ade", "#f1ecfa", "#1b1230"),
    "ink": ("#24134f", "#24134f", "#24134f", "#f8f6fc"),
    "white": ("#ffffff", "#ffffff", "#ffffff", "#1b1230"),
}


def symbol(colors, x=0, y=0, size=512, themed=False):
    artwork = deepcopy(mark)
    for index, path in enumerate(artwork.findall(f".//{{{SVG_NS}}}path")):
        path.set("fill", colors[index])
        if themed:
            path.set("class", ("first", "second")[index])
    content = "".join(ET.tostring(child, encoding="unicode") for child in artwork)
    left, top, width, _ = MARK_VIEWBOX
    return f'<g transform="translate({x} {y}) scale({size / width}) translate({-left} {-top})">{content}</g>'


def svg(body, width=512, height=512):
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-label="Raphael">{body}</svg>\n'


def render(document, size=None):
    encoded = document.encode()
    stream = skia.MemoryStream(encoded)
    dom = skia.SVGDOM.MakeFromStream(stream)
    if dom is None:
        raise ValueError("Unable to parse generated SVG")
    native = dom.containerSize()
    width, height = size or (round(native.width()), round(native.height()))
    surface = skia.Surface(width, height)
    canvas = surface.getCanvas()
    canvas.clear(skia.ColorTRANSPARENT)
    canvas.scale(width / native.width(), height / native.height())
    dom.render(canvas)
    encoded_png = bytes(surface.makeImageSnapshot().encodeToData())
    raster = Image.open(io.BytesIO(encoded_png))
    if raster.mode == "RGBA" and raster.getchannel("A").getextrema() == (255, 255):
        output = io.BytesIO()
        raster.convert("RGB").save(output, format="PNG")
        return output.getvalue()
    return encoded_png


def save(name, document, sizes=None):
    (BRAND / f"{name}.svg").write_text(document)
    (BRAND / f"{name}.png").write_bytes(render(document, sizes))


# Sora's outlines are preserved in the master, so regeneration needs no font package.
word = ET.parse(SOURCE / "wordmark.svg").getroot()
advance = float(word.attrib["width"])
UNITS = float(word.attrib["data-units-per-em"])
word_group = word.find(f"{{{SVG_NS}}}g")
if word_group is None:
    raise ValueError("The wordmark master must contain an outline group")


def wordmark(color, x, baseline, size):
    artwork = deepcopy(word_group)
    artwork.set("fill", color)
    for child in artwork.iter():
        if child.get("fill") not in (None, "none"):
            child.set("fill", color)
    content = ET.tostring(artwork, encoding="unicode")
    return f'<g transform="translate({x} {baseline}) scale({size / UNITS})">{content}</g>'


for name, colors in PALETTES.items():
    save(f"mark-{name}", svg(symbol(colors)), (1024, 1024))
    text_size = 156
    text_width = advance * text_size / UNITS
    save(f"logo-horizontal-{name}", svg(symbol(colors, 0, 0, 256) + wordmark(colors[2], 294, 181, text_size), round(318 + text_width), 256))
    text_size = 116
    text_width = advance * text_size / UNITS
    save(f"logo-stacked-{name}", svg(symbol(colors, 80, 0, 352) + wordmark(colors[2], (512 - text_width) / 2, 464, text_size)))


def app_icon(colors, background, monochrome=False):
    fills = ("#e8e8e8", "#e8e8e8") if monochrome else colors
    return svg(f'<rect width="1024" height="1024" fill="{background}"/>' + symbol(fills, 152, 152, 720), 1024, 1024)


for theme in ("light", "dark"):
    document = app_icon(PALETTES[theme], PALETTES[theme][3])
    save(f"app-icon-{theme}", document)
tinted = app_icon(PALETTES["white"], "#000000", True)
save("app-icon-tinted", tinted)

# The 491x427 source mark fits within Android's centered 66/108 safe circle.
for name, colors in (("android-foreground", PALETTES["light"]), ("android-monochrome", PALETTES["white"])):
    document = svg(symbol(colors, 280, 280, 464), 1024, 1024)
    save(name, document)

for theme in ("light", "dark"):
    save(f"splash-{theme}", svg(symbol(PALETTES[theme])))

# White alpha-only notification artwork is available for future Android use.
save("notification", svg(symbol(PALETTES["white"])), (96, 96))

web = BRAND / "web"
web.mkdir(exist_ok=True)
light, dark = PALETTES["light"], PALETTES["dark"]
favicon = svg(f'<style>.first{{fill:{light[0]}}}.second{{fill:{light[1]}}}@media(prefers-color-scheme:dark){{.first{{fill:{dark[0]}}}.second{{fill:{dark[1]}}}}}</style>' + symbol(light, themed=True))
(web / "favicon.svg").write_text(favicon)
for size in (16, 32, 48, 180, 192, 512):
    document = app_icon(PALETTES["light"], PALETTES["light"][3])
    (web / f"icon-{size}.png").write_bytes(render(document, (size, size)))
ico = Image.open(io.BytesIO(render(app_icon(PALETTES["light"], PALETTES["light"][3]), (256, 256))))
ico.save(web / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])

# A desktop-neutral source, with no operating-system-specific mask baked in.
save("desktop-icon", app_icon(PALETTES["light"], PALETTES["light"][3]))

manifest = {
    "identity": "Twin Mind",
    "source": "assets/brand/source/twin-mind-original.png",
    "masters": ["assets/brand/source/mark.svg", "assets/brand/source/wordmark.svg"],
    "preview": "assets/brand/preview.png",
    "geometry": "Hand-drawn scalable Bezier paths; identical across all variants",
    "wordmark": "Lowercase raphael, outlined Sora SemiBold",
    "palettes": PALETTES,
    "primary": "logo-horizontal-light.svg",
    "dark": "logo-horizontal-dark.svg",
    "silhouettes": ["mark-ink.svg", "mark-white.svg"],
    "appIcons": {"ios": ["app-icon-light.png", "app-icon-dark.png", "app-icon-tinted.png"], "android": ["android-foreground.png", "android-monochrome.png"]},
    "usage": {"clearSpace": "At least 1/8 of the mark width on each side", "minimumMarkSize": "16px for favicon; prefer 24px or larger elsewhere", "backgrounds": "Transparent logos; full square opaque iOS and desktop sources; OS applies launcher masks", "android": "Foreground fits the centered 66/108 safe circle; background #f8f6fc", "web": "favicon.svg switches palette with system appearance; 180px apple-touch icon; 192/512px manifest icons", "desktop": "1024px PNG and SVG sources; create platform containers when the desktop framework is chosen"},
    "regenerate": "pnpm icons:app",
}
(BRAND / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(f"Generated Twin Mind assets in {BRAND}")
