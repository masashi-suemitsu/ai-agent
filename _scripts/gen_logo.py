"""Generate the タスクAIエージェント logo as a 120x120 PNG."""
from PIL import Image, ImageDraw, ImageFont
import os, sys

OUT = r"C:\Users\masas\OneDrive\Dev-gitacro\ai-agent\home\ec2-user\claude-agent-web\public\assets\logo.png"
SIZE = 120
RADIUS = 32
BG = (91, 110, 255, 255)       # #5b6eff
FG = (255, 255, 255, 255)
LETTER = "T"

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)
draw.rounded_rectangle([0, 0, SIZE, SIZE], radius=RADIUS, fill=BG)

# Try common bold sans-serif fonts on Windows.
font = None
for path in [
    r"C:\Windows\Fonts\seguibl.ttf",   # Segoe UI Black
    r"C:\Windows\Fonts\segoeuib.ttf",  # Segoe UI Bold
    r"C:\Windows\Fonts\arialbd.ttf",   # Arial Bold
    r"C:\Windows\Fonts\YuGothB.ttc",
]:
    if os.path.exists(path):
        try:
            font = ImageFont.truetype(path, 78)
            break
        except Exception:
            continue
if font is None:
    font = ImageFont.load_default()

bbox = draw.textbbox((0, 0), LETTER, font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
x = (SIZE - tw) / 2 - bbox[0]
y = (SIZE - th) / 2 - bbox[1] - 3   # nudge up slightly for visual centering
draw.text((x, y), LETTER, fill=FG, font=font)

img.save(OUT, "PNG", optimize=True)
print(f"saved: {OUT}  size: {os.path.getsize(OUT)} bytes")
