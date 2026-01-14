
import os
import sys
import cv2
import numpy as np

# Use command-line arguments or default to relative paths
script_dir = os.path.dirname(os.path.abspath(__file__))
default_input = os.path.join(script_dir, 'public', 'images', 'space_agent_final_v2.png')
default_output = os.path.join(script_dir, 'public', 'images', 'space_agent_final_v3.png')

INPUT_PATH = sys.argv[1] if len(sys.argv) > 1 else default_input
OUTPUT_PATH = sys.argv[2] if len(sys.argv) > 2 else default_output

print(f"Reading {INPUT_PATH}...")
# Read image with alpha channel
img = cv2.imread(INPUT_PATH, cv2.IMREAD_UNCHANGED)

if img is None:
    print("Error: Image not found!")
    sys.exit(1)

# Extract alpha channel
alpha = img[:, :, 3]

# Threshold alpha to get binary mask of non-transparent pixels
# Any pixel with alpha > 0 is considered part of an object (including noise)
_, thresh = cv2.threshold(alpha, 0, 255, cv2.THRESH_BINARY)

# Find connected components
num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(thresh, connectivity=8)

print(f"Found {num_labels} components.")

# Find the label with the largest area (ignoring label 0 which is background)
if num_labels > 1:
    # Get areas for all labels except background (label 0)
    areas = stats[1:, cv2.CC_STAT_AREA]
    # Find the index of the largest area (add 1 to account for skipping label 0)
    max_label = np.argmax(areas) + 1
    max_area = areas[max_label - 1]
    
    print(f"Largest component is label {max_label} with area {max_area}")
    
    # Create a mask for the largest component
    mask = np.zeros_like(alpha)
    mask[labels == max_label] = 255
    
    # Apply mask to alpha channel
    # Everything NOT in the mask becomes fully transparent
    img[:, :, 3] = cv2.bitwise_and(alpha, mask)
else:
    print("No components found besides background")

# Save output
cv2.imwrite(OUTPUT_PATH, img)
print(f"Saved cleaned image to {OUTPUT_PATH}")
