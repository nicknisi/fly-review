export type ReviewAction =
  | {
      action: 'review';
      caseId: string;
      mode: 'jev' | 'manual';
      features?: unknown;
      custom?: unknown;
      pullRequest?: unknown;
      seed?: number;
      disclosure?: string;
    }
  | {
      action:
        | 'disconnect'
        | 'repeat'
        | 'second-opinion'
        | 'post-review'
        | 'recall'
        | 'reset-memory'
        | 'compare-memory'
        | 'add-bitter';
    }
  | { action: 'verify'; vote?: 'yes' | 'no' | 'unsure' }
  | { action: 'poke'; stimuli: unknown; seed?: number };

/** Establish the outer request contract; payload-specific parsers run before any operation mutates a review. */
export function parseReviewAction(value: unknown): ReviewAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a review action object');
  const input = value as Record<string, unknown>;
  switch (input.action) {
    case 'review':
      if (typeof input.caseId !== 'string' || !input.caseId) throw new Error('Select a review example');
      if (input.mode !== 'jev' && input.mode !== 'manual') throw new Error('Select live Jev or explicit manual inputs');
      if (
        input.disclosure !== undefined &&
        (typeof input.disclosure !== 'string' || !/^[a-f0-9]{64}$/.test(input.disclosure))
      )
        throw new Error('Invalid code disclosure acknowledgment');
      break;
    case 'verify':
      if (input.vote !== undefined && !['yes', 'no', 'unsure'].includes(input.vote as string))
        throw new Error('Invalid prediction');
      break;
    case 'poke':
      if (!input.stimuli || typeof input.stimuli !== 'object' || Array.isArray(input.stimuli))
        throw new Error('Select sensory populations');
      break;
    case 'disconnect':
    case 'repeat':
    case 'second-opinion':
    case 'post-review':
    case 'recall':
    case 'reset-memory':
    case 'compare-memory':
    case 'add-bitter':
      break;
    default:
      throw new Error('Unknown review action');
  }
  if (
    input.seed !== undefined &&
    (typeof input.seed !== 'number' || !Number.isInteger(input.seed) || input.seed < 1 || input.seed > 9999)
  )
    throw new Error('A fly is a seed from 1 to 9999');
  return input as ReviewAction;
}
