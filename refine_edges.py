
import cv2
import numpy as np

INPUT_PATH = '/home/onrm/projects/agentsMCPspace/AgentsMCPspace/public/images/space_agent_final.png'
OUTPUT_PATH = '/home/onrm/projects/agentsMCPspace/AgentsMCPspace/public/images/space_agent_final_v4.png'

print(f"Reading {INPUT_PATH}...")
img = cv2.imread(INPUT_PATH, cv2.IMREAD_UNCHANGED)

if img is None:
    print("Error: Image not found!")
    exit(1)

# Split channels
b, g, r, a = cv2.split(img)

# 1. Erode the alpha channel to remove fringe pixels
# Make a 3x3 kernel
kernel = np.ones((3,3), np.uint8)
# Erode alpha
a_eroded = cv2.erode(a, kernel, iterations=1)

# 2. Gaussian Blur the alpha channel for smoother edges (feathering)
a_blurred = cv2.GaussianBlur(a_eroded, (3, 3), 0)

# Merge back
img_final = cv2.merge((b, g, r, a_blurred))

cv2.imwrite(OUTPUT_PATH, img_final)
print(f"Saved refined image to {OUTPUT_PATH}")
