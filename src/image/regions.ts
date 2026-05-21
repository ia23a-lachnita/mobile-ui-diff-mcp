export interface Box { x: number; y: number; width: number; height: number; }

export function detectRegions(
  mask: boolean[][],
  minArea: number = 25,
  mergeDistance: number = 12
): Box[] {
  const height = mask.length;
  if (height === 0) return [];
  const width = mask[0].length;

  const visited = Array(height).fill(null).map(() => Array(width).fill(false));
  const boxes: Box[] = [];

  // 1. Find connected components
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y][x] && !visited[y][x]) {
        boxes.push(bfs(mask, visited, x, y, width, height));
      }
    }
  }

  // 2. Filter tiny components
  let filtered = boxes.filter(b => (b.width * b.height) >= minArea);

  // 3. Merge close boxes
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < filtered.length; i++) {
      for (let j = i + 1; j < filtered.length; j++) {
        const b1 = filtered[i];
        const b2 = filtered[j];
        if (boxesOverlapOrClose(b1, b2, mergeDistance)) {
          const minX = Math.min(b1.x, b2.x);
          const minY = Math.min(b1.y, b2.y);
          const maxX = Math.max(b1.x + b1.width, b2.x + b2.width);
          const maxY = Math.max(b1.y + b1.height, b2.y + b2.height);
          
          filtered[i] = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
          filtered.splice(j, 1);
          merged = true;
          break;
        }
      }
      if (merged) break;
    }
  }

  // 4. Sort top-to-bottom, left-to-right
  filtered.sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y;
    return a.x - b.x;
  });

  return filtered;
}

function bfs(mask: boolean[][], visited: boolean[][], startX: number, startY: number, width: number, height: number): Box {
  let minX = startX;
  let maxX = startX;
  let minY = startY;
  let maxY = startY;

  const queue: [number, number][] = [[startX, startY]];
  visited[startY][startX] = true;

  const dirs = [
    [-1, -1], [0, -1], [1, -1],
    [-1,  0],          [1,  0],
    [-1,  1], [0,  1], [1,  1]
  ];

  let head = 0;
  while (head < queue.length) {
    const [cx, cy] = queue[head++];
    
    if (cx < minX) minX = cx;
    if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy;
    if (cy > maxY) maxY = cy;

    for (const [dx, dy] of dirs) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        if (mask[ny][nx] && !visited[ny][nx]) {
          visited[ny][nx] = true;
          queue.push([nx, ny]);
        }
      }
    }
  }

  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function boxesOverlapOrClose(b1: Box, b2: Box, distance: number): boolean {
  return !(
    b1.x > b2.x + b2.width + distance ||
    b1.x + b1.width + distance < b2.x ||
    b1.y > b2.y + b2.height + distance ||
    b1.y + b1.height + distance < b2.y
  );
}
