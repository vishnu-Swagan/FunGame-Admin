"""Render every PWA/Apple icon from the approved 3D roulette brand master."""

from pathlib import Path

from PIL import Image


PUBLIC_DIR = Path(__file__).resolve().parents[1] / "public"
BRAND_MASTER = PUBLIC_DIR / "chakri-roulette-emblem-transparent.png"


def render_square(source, size):
    return source.resize((size, size), Image.Resampling.LANCZOS)


def render_maskable(source, size):
    """Keep the transparent 3D emblem inside Android's safe circle."""
    background = Image.new("RGB", (size, size), "#09090d")
    artwork_size = round(size * 0.72)
    artwork = source.resize((artwork_size, artwork_size), Image.Resampling.LANCZOS)
    offset = (size - artwork_size) // 2
    background.paste(artwork, (offset, offset), artwork)
    return background


def main():
    with Image.open(BRAND_MASTER) as source_image:
        # Preserve the approved emblem's real alpha channel for standard app
        # icons. Only the maskable Android variant receives its required
        # page-native backing colour in ``render_maskable``.
        source = source_image.convert("RGBA")
        outputs = {
            "chakri-app-icon-512.png": 512,
            "chakri-app-icon-192.png": 192,
            "chakri-apple-touch-icon.png": 180,
            "chakri-favicon.png": 64,
        }
        for name, size in outputs.items():
            render_square(source, size).save(PUBLIC_DIR / name, "PNG", optimize=True)
        render_maskable(source, 512).save(
            PUBLIC_DIR / "chakri-app-icon-maskable-512.png",
            "PNG",
            optimize=True,
        )


if __name__ == "__main__":
    main()
