
import sys
from PIL import Image
import math

# Config
THRESHOLD = 10  # Stricter threshold to preserve white robot parts
INPUT_PATH = '/home/onrm/.gemini/antigravity/brain/0e4b9a2f-c9f2-4718-bde9-cae0090e3546/space_agent_fixed_1768216638705.png'
OUTPUT_PATH = '/home/onrm/projects/agentsMCPspace/AgentsMCPspace/public/images/space_agent_final_v2.png'

def color_dist(c1, c2):
    r = c1[0] - c2[0]
    g = c1[1] - c2[1]
    b = c1[2] - c2[2]
    return math.sqrt(r*r + g*g + b*b)

try:
    img = Image.open(INPUT_PATH).convert("RGBA")
    width, height = img.size
    pixels = img.load()
    
    # Corners to start flood fill
    starts = [(0, 0), (width-1, 0), (0, height-1), (width-1, height-1)]
    
    visited = set()
    queue = []
    
    # Get background colors from corners
    bg_colors = []
    for x, y in starts:
        bg_colors.append(pixels[x, y])
        queue.append((x, y))
        visited.add((x, y))

    # Simple flood fill
    # Note: large images might hit recursion limit if recursive, so using iterative queue
    while queue:
        x, y = queue.pop(0)
        
        # Make transparent
        pixels[x, y] = (0, 0, 0, 0)
        
        # Check neighbors
        for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            nx, ny = x + dx, y + dy
            
            if 0 <= nx < width and 0 <= ny < height:
                if (nx, ny) not in visited:
                    current_color = pixels[nx, ny]
                    
                    # Check if close to ANY of the corner start colors (which are likely background)
                    is_bg = False
                    for bg_color in bg_colors:
                        if color_dist(current_color, bg_color) < THRESHOLD:
                            is_bg = True
                            break
                    
                    if is_bg:
                        visited.add((nx, ny))
                        queue.append((nx, ny))

    img.save(OUTPUT_PATH, "PNG")
    print(f"Saved transparent image to {OUTPUT_PATH}")

except Exception as e:
    print(f"Error: {e}")
