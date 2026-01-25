
import os
import sys
from PIL import Image

DEFAULT_IMAGE_PATH = os.path.join(
    os.path.dirname(__file__),
    "public",
    "images",
    "space_agent_final.png",
)
image_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_IMAGE_PATH

try:
    img = Image.open(image_path)
    print(f"Format: {img.format}")
    print(f"Mode: {img.mode}")
    
    # Check corners
    width, height = img.size
    corners = [
        (0, 0),
        (width-1, 0),
        (0, height-1),
        (width-1, height-1)
    ]
    
    print("Corner pixels:")
    for x, y in corners:
        pixel = img.getpixel((x, y))
        print(f"({x}, {y}): {pixel}")

except Exception as e:
    print(f"Error: {e}")
