#!/usr/bin/env python3
"""Every app icon from the owner's artwork (gui/src-tauri/icons/app-icon.svg, a full-bleed rounded tile).

  macOS    on Apple's icon grid (824 px tile, 100 px margin): macOS doesn't shape icons, so the margin is the icon's
  Windows, Linux  the artwork as it is (png, ico, Windows tiles)
  iOS      square corners, no transparency: iOS rounds the corners itself
  Android  adaptive icon: the gradient as background, the white layers as foreground inside the safe zone;
           the rounded and a circular tile for launchers without adaptive icons

Writes gui/src-tauri/icons/ and the generated projects (gen/apple, gen/android). Needs Pillow and the Tauri CLI.
Usage: python3 scripts/gen-icons.py
"""
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
TAURI = ROOT / "gui/src-tauri"
ICONS = TAURI / "icons"
APPICONSET = TAURI / "gen/apple/Assets.xcassets/AppIcon.appiconset"
RES = TAURI / "gen/android/app/src/main/res"
# Android densities: legacy icon 48 dp, adaptive layers 108 dp
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
ADAPTIVE = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@mipmap/ic_launcher_background"/>
  <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
"""


def render(svg: str, tmp: Path, name: str) -> Path:
    """Runs `tauri icon` on an SVG; returns its output directory."""
    src, out = tmp / f"{name}.svg", tmp / name
    src.write_text(svg)
    subprocess.run(["npx", "tauri", "icon", str(src), "-o", str(out)], cwd=ROOT / "gui", check=True, capture_output=True)
    return out


def big(out: Path) -> Image.Image:
    return Image.open(out / "icon.png").convert("RGBA")  # 512 px with transparency (the iOS set is flattened)


def main() -> None:
    art = (ICONS / "app-icon.svg").read_text()
    head, body = art[: art.index("</defs>") + 7], art[art.index("</defs>") + 7 : art.rindex("</svg>")]
    tile = re.search(r"<rect [^>]*/>", body).group(0)
    layers = body.replace(tile, "")
    flat = re.sub(r'\s*rx="[^"]*"', "", tile)  # the tile with square corners
    k = 2 / 3  # the layers keep the artwork's proportion inside the 72 dp a launcher shows of 108
    variants = {
        "round": art,
        "mac": f'{head}<g transform="translate(100 100) scale({824 / 1024})">{body}</g></svg>',
        "square": art.replace(tile, flat),
        "fg": f'{head}<g transform="translate({512 * (1 - k):.3f} {512 * (1 - k):.3f}) scale({k:.5f})">{layers}</g></svg>',
        "bg": f"{head}{flat}</svg>",
    }
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        out = {name: render(svg, tmp, name) for name, svg in variants.items()}

        # desktop: the artwork as it is, macOS's on its grid
        for f in out["round"].iterdir():
            if f.is_file():
                shutil.copy(f, ICONS / f.name)
        shutil.copy(out["mac"] / "icon.icns", ICONS / "icon.icns")

        # iOS: square, opaque
        for f in sorted((out["square"] / "ios").iterdir()):
            Image.open(f).convert("RGB").save(ICONS / "ios" / f.name)
        if APPICONSET.exists():
            for f in (ICONS / "ios").iterdir():
                shutil.copy(f, APPICONSET / f.name)

        # Android
        rounded, square, fg, bg = big(out["round"]), big(out["square"]), big(out["fg"]), big(out["bg"])
        mask = Image.new("L", square.size, 0)
        ImageDraw.Draw(mask).ellipse((0, 0, *square.size), fill=255)
        circle = Image.new("RGBA", square.size, (0, 0, 0, 0))
        circle.paste(square, mask=mask)
        for res in (ICONS / "android", RES):
            if not res.exists():
                continue
            for d, x in DENSITIES.items():
                dir = res / f"mipmap-{d}"
                dir.mkdir(exist_ok=True)
                legacy, layer = round(48 * x), round(108 * x)
                rounded.resize((legacy, legacy), Image.LANCZOS).save(dir / "ic_launcher.png")
                circle.resize((legacy, legacy), Image.LANCZOS).save(dir / "ic_launcher_round.png")
                fg.resize((layer, layer), Image.LANCZOS).save(dir / "ic_launcher_foreground.png")
                bg.convert("RGB").resize((layer, layer), Image.LANCZOS).save(dir / "ic_launcher_background.png")
            (res / "mipmap-anydpi-v26").mkdir(exist_ok=True)
            (res / "mipmap-anydpi-v26/ic_launcher.xml").write_text(ADAPTIVE)
            (res / "values/ic_launcher_background.xml").unlink(missing_ok=True)  # the background is the gradient now
    print("icons written")


if __name__ == "__main__":
    main()
