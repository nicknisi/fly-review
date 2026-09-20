/**
 * Sensory populations the simulation can stimulate. Each maps to an annotated class in the male CNS connectome and to
 * a place on the animal. The "expect" column is what the same stimulus does in a living fly and is there so you can
 * check the simulation against it; it is not fed back into anything.
 *
 * The review encoder and the poke buttons draw from the same list, so a review is literally a set of pokes chosen by
 * Jev's judgments.
 */
export const POKE_PRESETS = {
  sugar: {
    label: 'Sugar on the labellum',
    part: 'proboscis',
    population: 'labellar and pharyngeal sugar-sensing gustatory neurons (LB3b, LB3c, PhG1a-c)',
    expect: 'proboscis extension: MN9 should fire',
  },
  bitter: {
    label: 'Bitter on the labellum',
    part: 'proboscis',
    population: 'LB1 labellar gustatory neurons',
    expect: 'rejection: sugar-driven proboscis extension stops',
  },
  feet: {
    label: 'Sugar on the feet',
    part: 'legs',
    population: 'tarsal gustatory bristle neurons',
    expect: 'flies taste with their feet; in the real animal this can also drive proboscis extension',
  },
  antennae: {
    label: 'Deflect the antennae',
    part: 'antennae',
    population: 'Johnston’s organ wind, gravity, and grooming neurons',
    expect: 'antennal grooming: DNg62 should fire',
  },
  eyes: {
    label: 'Looming shadow',
    part: 'eyes',
    population: 'LC4 and LPLC2 looming-detector visual projection neurons',
    expect: 'escape takeoff: the giant fiber DNp01 should fire',
  },
  light: {
    label: 'Flash of light',
    part: 'eyes',
    population: 'R1-R6 photoreceptors',
    expect: 'the optic lobes light up; no reason for any of the three readouts to respond',
  },
  fruit: {
    label: 'Smell of fruit',
    part: 'antennae',
    population: 'food-odor olfactory receptor neurons (DM1, DM2, DM4, VA2, VM5d, DL1)',
    expect: 'antennal lobe activity; appetitive, so some feeding drive is plausible',
  },
  mold: {
    label: 'Smell of mold',
    part: 'antennae',
    population: 'DA2 geosmin receptor neurons',
    expect: 'aversion in a real fly; here it barely moves the readouts',
  },
  co2: {
    label: 'Puff of CO2',
    part: 'antennae',
    population: 'V-glomerulus CO2 receptor neurons',
    expect: 'aversion in a real fly; here it barely moves the readouts',
  },
  pheromone: {
    label: 'Pheromone (cVA)',
    part: 'antennae',
    population: 'ORN DA1 and VA1v pheromone receptor neurons',
    expect: 'courtship circuitry; not one of the three readouts',
  },
  brush: {
    label: 'Brush the bristles',
    part: 'body',
    population: 'mechanosensory bristle neurons across the body',
    expect: 'grooming of the touched region in a real fly; the readouts only cover antennal grooming',
  },
  abdomen: {
    label: 'Tap the abdomen',
    part: 'abdomen',
    population: 'abdominal sensory neurons',
    expect: 'largely uncharted here; watch the ventral nerve cord',
  },
} as const;
export type PokePreset = keyof typeof POKE_PRESETS;
export const POKE_NAMES = Object.keys(POKE_PRESETS) as PokePreset[];
export type PokeStimuli = Partial<Record<PokePreset, number>>;
export const DEFAULT_POKE_HZ = 150;
export const MAX_STIMULUS_HZ = 180;

export function parsePokeStimuli(value: unknown, limit = 3): PokeStimuli {
  if (!value || typeof value !== 'object') throw new Error('Choose something to poke');
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length || entries.length > limit) throw new Error(`Poke one to ${limit} populations at a time`);
  const stimuli: PokeStimuli = {};
  for (const [name, hz] of entries) {
    if (!POKE_NAMES.includes(name as PokePreset)) throw new Error(`Unknown poke: ${name}`);
    if (typeof hz !== 'number' || !Number.isFinite(hz) || hz <= 0 || hz > 200)
      throw new Error('Stimulation must be 1 to 200 Hz');
    stimuli[name as PokePreset] = hz;
  }
  return stimuli;
}
