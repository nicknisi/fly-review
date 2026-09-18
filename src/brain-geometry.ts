export type XYZ = readonly [number, number, number];
export type GeometryTransform = { center: [number, number, number]; scale: number };

/** Preserve all three measured axes and relative distances; only center, orient, and uniformly scale. */
export function geometryTransform(points: readonly XYZ[]): GeometryTransform {
  if (!points.length || points.some(p => p.length !== 3 || p.some(n => !Number.isFinite(n)))) throw new Error('Invalid 3D neuron coordinates');
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], p[axis]); max[axis] = Math.max(max[axis], p[axis]); }
  return { center: min.map((n, i) => (n + max[i]) / 2) as [number, number, number], scale: 2 / Math.max(1, ...min.map((n, i) => max[i] - n)) };
}
export function normalizePoint(p: XYZ, transform: GeometryTransform): [number, number, number] {
  const { center: c, scale: s } = transform;
  // Dataset x/z is the familiar frontal projection; measured y becomes depth.
  return [(p[0] - c[0]) * s, -(p[2] - c[2]) * s, (p[1] - c[1]) * s];
}
