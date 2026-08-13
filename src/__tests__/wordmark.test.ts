import { describe, expect, it } from "vitest";
import { buildBubbleCodeGrid } from "../tui-ink/wordmark.js";

describe("Bubble Code wordmark", () => {
  it("builds an 8-row extruded grid with front, shadow, and highlight cells", () => {
    const grid = buildBubbleCodeGrid();

    // 7 letter rows + 1 shadow-extrusion row.
    expect(grid).toHaveLength(8);

    const colors = new Set<string>();
    let filled = 0;
    for (const row of grid) {
      for (const cell of row) {
        if (cell.color) {
          colors.add(cell.color);
          filled += 1;
        }
      }
    }

    expect(filled).toBeGreaterThan(0);
    expect(colors).toContain("#E0E6ED"); // front face (light gray)
    expect(colors).toContain("#3A4A5A"); // extrusion shadow (dark slate)
    expect(colors).toContain("#FFFFFF"); // top-edge highlight (white)
  });

  it("fits within a standard terminal width", () => {
    const grid = buildBubbleCodeGrid();
    const width = grid[0].length;
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThanOrEqual(80);
  });
});
