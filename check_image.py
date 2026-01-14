
import os
import sys
from PIL import Image

# Use command-line argument or default to relative path
script_dir = os.path.dirname(os.path.abspath(__file__))
default_path = os.path.join(script_dir, 'public', 'images', 'space_agent_final.png')
image_path = sys.argv[1] if len(sys.argv) > 1 else default_path

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
    sys.exit(1)
