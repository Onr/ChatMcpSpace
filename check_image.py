
import os
from PIL import Image

image_path = '/home/onrm/projects/agentsMCPspace/AgentsMCPspace/public/images/space_agent_final.png'

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
