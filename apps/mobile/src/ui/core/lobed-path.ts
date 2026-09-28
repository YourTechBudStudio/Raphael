/** Points around the outline. Enough that the lobes read as curves at 54 points and above. */
const OUTLINE_STEPS = 120;

/**
 * A closed, smooth outline whose radius swells `lobes` times around the circle.
 *
 * The base radius is shrunk by the depth so the outermost swell still touches the box edge, never
 * past it: the shape fills its box whatever its lobe count.
 */
export function lobedPath(size: number, lobes: number, depth: number): string {
  const centre = size / 2;
  const base = centre / (1 + depth);
  const points: string[] = [];

  for (let step = 0; step <= OUTLINE_STEPS; step += 1) {
    const angle = (step / OUTLINE_STEPS) * Math.PI * 2;
    const radius = base * (1 + depth * Math.cos(lobes * angle));
    const x = centre + radius * Math.cos(angle);
    const y = centre + radius * Math.sin(angle);
    points.push(`${step === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`);
  }

  return `${points.join(' ')} Z`;
}
