
import os
import sys
import cv2
import numpy as np

DEFAULT_INPUT_PATH = os.path.join(
    os.path.dirname(__file__),
    "public",
    "images",
    "space_agent_final_v2.png",
)
DEFAULT_OUTPUT_PATH = os.path.join(
    os.path.dirname(__file__),
    "public",
    "images",
    "space_agent_final_v3.png",
)
INPUT_PATH = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_INPUT_PATH
OUTPUT_PATH = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUTPUT_PATH

print(f"Reading {INPUT_PATH}...")
# Read image with alpha channel
img = cv2.imread(INPUT_PATH, cv2.IMREAD_UNCHANGED)

if img is None:
    print("Error: Image not found!")
    exit(1)

# Extract alpha channel
alpha = img[:, :, 3]

# Threshold alpha to get binary mask of non-transparent pixels
# Any pixel with alpha > 0 is considered part of an object (including noise)
_, thresh = cv2.threshold(alpha, 0, 255, cv2.THRESH_BINARY)

# Find connected components
num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(thresh, connectivity=8)

print(f"Found {num_labels} components.")

# Find the label with the largest area (ignoring label 0 which is background)
max_area = 0
max_label = -1

for i in range(1, num_labels):
    area = stats[i, cv2.CC_STAT_AREA]
    if area > max_area:
        max_area = area
        max_label = i

print(f"Largest component is label {max_label} with area {max_area}")

# Create a mask for the largest component
mask = np.zeros_like(alpha)
mask[labels == max_label] = 255

# Apply mask to alpha channel
# Everything NOT in the mask becomes fully transparent
img[:, :, 3] = cv2.bitwise_and(alpha, mask)

# Save output
cv2.imwrite(OUTPUT_PATH, img)
print(f"Saved cleaned image to {OUTPUT_PATH}")
