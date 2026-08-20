"""Render the Chakri.Casino vector mark into PWA and Apple icon sizes."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


SIZE = 1024
PUBLIC_DIR = Path(__file__).resolve().parents[1] / "public"


def vertical_gradient(size, top, bottom):
    strip = Image.new("RGB", (1, size))
    pixels = strip.load()
    for y in range(size):
        ratio = y / (size - 1)
        pixels[0, y] = tuple(round(a + (b - a) * ratio) for a, b in zip(top, bottom))
    return strip.resize((size, size), Image.Resampling.BILINEAR).convert("RGBA")


def make_icon():
    image = vertical_gradient(SIZE, (23, 29, 49), (3, 5, 11))

    # Warm central light stays inside the maskable safe zone.
    glow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((190, 128, 834, 772), fill=(255, 196, 65, 100))
    glow = glow.filter(ImageFilter.GaussianBlur(132))
    image = Image.alpha_composite(image, glow)

    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((48, 48, 976, 976), radius=188, outline=(227, 175, 63, 255), width=20)
    draw.rounded_rectangle((76, 76, 948, 948), radius=164, outline=(255, 232, 161, 44), width=4)

    # Diamond shadow and facets mirror the code-native mark in Brand.js.
    shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    diamond = [(512, 226), (741, 451), (512, 800), (283, 451)]
    shadow_draw.polygon([(x, y + 28) for x, y in diamond], fill=(0, 0, 0, 180))
    shadow = shadow.filter(ImageFilter.GaussianBlur(27))
    image = Image.alpha_composite(image, shadow)

    gold = vertical_gradient(SIZE, (255, 243, 196), (127, 80, 16))
    diamond_mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(diamond_mask).polygon(diamond, fill=255)
    image.paste(gold, (0, 0), diamond_mask)

    draw = ImageDraw.Draw(image)
    draw.line(diamond + [diamond[0]], fill=(109, 67, 12, 255), width=14, joint="curve")
    draw.polygon([(512, 226), (741, 451), (512, 501)], fill=(255, 248, 218, 110))
    draw.polygon([(283, 451), (512, 501), (512, 800)], fill=(45, 23, 0, 48))
    draw.polygon([(741, 451), (512, 501), (512, 800)], fill=(94, 54, 0, 28))
    draw.polygon([(512, 226), (512, 501), (283, 451)], fill=(255, 255, 255, 20))
    draw.ellipse((417, 360, 479, 422), fill=(255, 255, 255, 224))
    draw.ellipse((414, 351, 436, 373), fill=(255, 255, 255, 255))
    return image.convert("RGB")


def make_maskable_icon():
    """Full-bleed background with every branded pixel inside the safe circle."""
    size = 512
    image = vertical_gradient(size, (23, 29, 49), (3, 5, 11))
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((80, 55, 432, 407), fill=(255, 196, 65, 96))
    image = Image.alpha_composite(image, glow.filter(ImageFilter.GaussianBlur(68)))

    draw = ImageDraw.Draw(image)
    draw.ellipse((74, 74, 438, 438), outline=(227, 175, 63, 255), width=12)
    draw.ellipse((88, 88, 424, 424), outline=(255, 232, 161, 55), width=3)

    diamond = [(256, 126), (370, 239), (256, 410), (142, 239)]
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).polygon([(x, y + 15) for x, y in diamond], fill=(0, 0, 0, 180))
    image = Image.alpha_composite(image, shadow.filter(ImageFilter.GaussianBlur(14)))

    gold = vertical_gradient(size, (255, 243, 196), (127, 80, 16))
    diamond_mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(diamond_mask).polygon(diamond, fill=255)
    image.paste(gold, (0, 0), diamond_mask)

    draw = ImageDraw.Draw(image)
    draw.line(diamond + [diamond[0]], fill=(109, 67, 12, 255), width=8, joint="curve")
    draw.polygon([(256, 126), (370, 239), (256, 264)], fill=(255, 248, 218, 110))
    draw.polygon([(142, 239), (256, 264), (256, 410)], fill=(45, 23, 0, 48))
    draw.polygon([(370, 239), (256, 264), (256, 410)], fill=(94, 54, 0, 28))
    draw.ellipse((209, 191, 241, 223), fill=(255, 255, 255, 224))
    draw.ellipse((207, 186, 219, 198), fill=(255, 255, 255, 255))
    return image.convert("RGB")


def main():
    icon = make_icon()
    outputs = {
        "chakri-app-icon-512.png": 512,
        "chakri-app-icon-192.png": 192,
        "chakri-apple-touch-icon.png": 180,
        "chakri-favicon.png": 64,
    }
    for name, size in outputs.items():
        icon.resize((size, size), Image.Resampling.LANCZOS).save(
            PUBLIC_DIR / name,
            "PNG",
            optimize=True,
        )

    make_maskable_icon().save(PUBLIC_DIR / "chakri-app-icon-maskable-512.png", "PNG", optimize=True)


if __name__ == "__main__":
    main()
