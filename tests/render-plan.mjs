/**
 * Renders a top-down SVG plan of the level plus the tested camera positions.
 * Used to sanity-check the geometry: if the plan does not show narrow corridors,
 * low-ceiling zones and a corner hugging route, the "tests" are meaningless.
 */
import { buildColliders } from '../src/core/levelSpec.js';
import fs from 'node:fs';

const colliders = buildColliders();
const scale = 46;
const pad = 40;
const minX = -7.6, maxX = 7.6, minZ = -8.6, maxZ = 5.4;
const w = (maxX - minX) * scale + pad * 2;
const h = (maxZ - minZ) * scale + pad * 2;
const sx = (x) => pad + (x - minX) * scale;
const sy = (z) => pad + (z - minZ) * scale;

const colors = {
  wall: '#7c828d', ceiling: '#4a3f5c', prop: '#8a6f4a', floor: '#22262c',
};

const parts = [];
parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<style>
  text { font: 11px ui-monospace, monospace; fill: #cfd6e2; }
</style>
<rect width="100%" height="100%" fill="#14171c"/>`);

// Grid at 1 m.
for (let x = Math.ceil(minX); x <= maxX; x++) {
  parts.push(`<line x1="${sx(x)}" y1="${sy(minZ)}" x2="${sx(x)}" y2="${sy(maxZ)}" stroke="#22262c"/>`);
}
for (let z = Math.ceil(minZ); z <= maxZ; z++) {
  parts.push(`<line x1="${sx(minX)}" y1="${sy(z)}" x2="${sx(maxX)}" y2="${sy(z)}" stroke="#22262c"/>`);
}

for (const b of colliders) {
  if (b.kind === 'floor') continue;
  const x = sx(b.min.x), z = sy(b.min.z);
  const ww = (b.max.x - b.min.x) * scale, hh = (b.max.z - b.min.z) * scale;
  const fill = colors[b.kind] ?? '#555';
  const alpha = b.kind === 'ceiling' ? 0.5 : 0.92;
  parts.push(`<rect x="${x}" y="${z}" width="${ww}" height="${hh}" fill="${fill}" fill-opacity="${alpha}" stroke="#0d1015" stroke-width="1"/>`);
  if (b.kind === 'wall' || b.kind === 'prop') {
    parts.push(`<text x="${x + ww / 2}" y="${z + hh / 2 + 3}" text-anchor="middle" font-size="9" fill="#e6ecf6" fill-opacity="0.7">${b.id}</text>`);
  }
}

// Character / camera routes from the headless scenario runs.
const routes = [
  { name: 'corridor', color: '#5bc8ff', pts: [[-3, 0], [0, 0], [0, -2.6], [0, -5]] },
  { name: 'low ceiling', color: '#ffb545', pts: [[0, 0.5], [0, -1.5], [0, -3.5], [0, -5.5]] },
  { name: 'wall hug', color: '#ff5d76', pts: [[-0.55, 1.2], [-0.55, -1.2], [-0.55, -3.4], [-0.55, -4.6], [1.6, -4.6]] },
  { name: 'column', color: '#63e2a4', pts: [[3.7, -0.55], [2.35, -2], [3.7, -3.45], [5.05, -2], [3.7, -0.55]] },
];
routes.forEach((route, i) => {
  const pts = route.pts.map(([x, z]) => `${sx(x)},${sy(z)}`).join(' ');
  parts.push(`<polyline points="${pts}" fill="none" stroke="${route.color}" stroke-width="2" stroke-dasharray="5 4" stroke-opacity="0.9"/>`);
  route.pts.forEach(([x, z]) => parts.push(`<circle cx="${sx(x)}" cy="${sy(z)}" r="3" fill="${route.color}"/>`));
  const [ax, az] = route.pts[0];
  parts.push(`<text x="${sx(ax)}" y="${sy(az) - 8}" fill="${route.color}">${route.name}</text>`);
});

parts.push(`<text x="${pad}" y="24" font-size="13">Room camera level plan · 1 m grid · solid = collider</text>`);
parts.push('</svg>');

fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/level-plan.svg', parts.join('\n'));
console.log('wrote artifacts/level-plan.svg');
