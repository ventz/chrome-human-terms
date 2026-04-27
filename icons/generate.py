#!/usr/bin/env python3
"""Generate icon-16/48/128 for Policy in Human Terms.

Design: rounded blue-square badge with a white document silhouette (three
horizontal text lines), overlaid by a green circular 'A+' grade badge in the
lower-right corner. Meaningful at 128px, still legible at 16px.
"""

from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

BLUE = (37, 99, 235, 255)        # --accent
BLUE_DARK = (30, 64, 175, 255)
GREEN = (21, 128, 61, 255)       # grade A color
WHITE = (255, 255, 255, 255)
TEXT_GRAY = (100, 116, 139, 255)

HERE = Path(__file__).resolve().parent


def rounded_rect(draw, xy, radius, fill):
    x0, y0, x1, y1 = xy
    draw.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=fill)


def make_icon(size: int, out: Path):
    # Render at 4x and downsample for crisp anti-aliasing.
    scale = 4
    S = size * scale
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Badge background: rounded blue square with subtle bottom shading.
    pad = int(S * 0.02)
    radius = int(S * 0.22)
    rounded_rect(d, (pad, pad, S - pad, S - pad), radius, BLUE)
    # Subtle darker band at the bottom for depth.
    d.rounded_rectangle(
        [pad, int(S * 0.68), S - pad, S - pad],
        radius=radius,
        fill=BLUE_DARK,
    )
    # Re-cover the upper portion to restore straight top edge.
    d.rectangle([pad, pad, S - pad, int(S * 0.70)], fill=BLUE)
    # Round the bottom again softly.
    rounded_rect(d, (pad, pad, S - pad, S - pad), radius, (0, 0, 0, 0))
    rounded_rect(d, (pad, pad, S - pad, S - pad), radius, BLUE)

    # White document card (policy page).
    doc_pad_x = int(S * 0.22)
    doc_pad_y = int(S * 0.18)
    doc_box = (doc_pad_x, doc_pad_y, S - doc_pad_x, S - int(S * 0.22))
    d.rounded_rectangle(doc_box, radius=int(S * 0.04), fill=WHITE)

    # Folded corner triangle (top-right of document).
    x0, y0, x1, y1 = doc_box
    fold = int((x1 - x0) * 0.18)
    d.polygon(
        [(x1 - fold, y0), (x1, y0 + fold), (x1 - fold, y0 + fold)],
        fill=(226, 232, 240, 255),
    )
    d.line([(x1 - fold, y0), (x1 - fold, y0 + fold), (x1, y0 + fold)],
           fill=(148, 163, 184, 255), width=max(1, int(S * 0.008)))

    # Horizontal text lines (3 of them, descending widths).
    line_h = max(1, int(S * 0.028))
    line_x0 = x0 + int((x1 - x0) * 0.12)
    line_x1_full = x1 - int((x1 - x0) * 0.12)
    line_start_y = y0 + int((y1 - y0) * 0.32)
    gap = int((y1 - y0) * 0.18)
    widths = [1.0, 0.78, 0.56]
    for i, w in enumerate(widths):
        ly = line_start_y + i * gap
        line_end = line_x0 + int((line_x1_full - line_x0) * w)
        d.rounded_rectangle(
            [line_x0, ly, line_end, ly + line_h * 2],
            radius=line_h,
            fill=TEXT_GRAY,
        )

    # Grade circle badge (bottom-right).
    badge_r = int(S * 0.24)
    cx = S - pad - int(badge_r * 0.85)
    cy = S - pad - int(badge_r * 0.85)
    # White ring for contrast against blue background.
    d.ellipse(
        [cx - badge_r - int(S * 0.025), cy - badge_r - int(S * 0.025),
         cx + badge_r + int(S * 0.025), cy + badge_r + int(S * 0.025)],
        fill=WHITE,
    )
    d.ellipse(
        [cx - badge_r, cy - badge_r, cx + badge_r, cy + badge_r],
        fill=GREEN,
    )

    # Letter "A" inside the badge.
    label = "A"
    try:
        # Try a nicer system font; fall back to default.
        font_size = int(badge_r * 1.35)
        try:
            font = ImageFont.truetype(
                "/System/Library/Fonts/Supplemental/Arial Bold.ttf", font_size
            )
        except Exception:
            font = ImageFont.truetype("Arial Bold.ttf", font_size)
    except Exception:
        font = ImageFont.load_default()

    bbox = d.textbbox((0, 0), label, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = cx - tw // 2 - bbox[0]
    ty = cy - th // 2 - bbox[1] - int(badge_r * 0.06)
    d.text((tx, ty), label, font=font, fill=WHITE)

    # Downsample to target size.
    out_img = img.resize((size, size), Image.LANCZOS)
    out_img.save(out, "PNG")
    print(f"wrote {out.name} ({size}x{size})")


def main():
    for s in (16, 48, 128):
        make_icon(s, HERE / f"icon-{s}.png")


if __name__ == "__main__":
    main()
