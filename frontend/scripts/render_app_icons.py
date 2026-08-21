"""Render every PWA/Apple icon from the approved 3D roulette brand master."""

from pathlib import Path

from PIL import Image


PUBLIC_DIR = Path(__file__).resolve().parents[1] / "public"
BRAND_MASTER = PUBLIC_DIR / "chakri-roulette-brand.png"


def render_square(source, size):
    return source.resize((size, size), Image.Resampling.LANCZOS)


def render_maskable(source, size):
    """Keep the roulette and 3D wordmark inside Android's safe circle."""
    background = Image.new("RGB", (size, size), "#09090d")
    artwork_size = round(size * 0.72)
    artwork = source.resize((artwork_size, artwork_size), Image.Resampling.LANCZOS)
    offset = (size - artwork_size) // 2
    background.paste(artwork, (offset, offset))
    return background


def main():
    with Image.open(BRAND_MASTER) as source_image:
        source = source_image.convert("RGB")
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
