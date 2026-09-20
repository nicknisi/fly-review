import type { ReviewCase, Scalar } from './review-cases.ts';

export function validateArgs(review: ReviewCase, value: unknown): Scalar[] {
  if (!Array.isArray(value) || value.length !== review.parameters.length)
    throw new Error(`Expected ${review.parameters.length} arguments for ${review.functionName}`);
  for (const [index, parameter] of review.parameters.entries()) {
    const argument: unknown = value[index];
    const valid =
      parameter.type === 'integer'
        ? typeof argument === 'number' &&
          Number.isInteger(argument) &&
          argument >= parameter.min &&
          argument <= parameter.max
        : parameter.type === 'boolean'
          ? typeof argument === 'boolean'
          : typeof argument === 'string' && parameter.values.includes(argument);
    if (!valid) throw new Error(`${parameter.name} is outside the documented contract`);
  }
  return [...value] as Scalar[];
}

/** Independent contract implementation. Never evaluates either submitted source version. */
export function contractExpected(review: ReviewCase, args: Scalar[]): Scalar {
  validateArgs(review, args);
  if (review.oracle === null) throw new Error('A pasted change has no contract or oracle, so it cannot be verified');
  if (review.oracle === 'reference')
    throw new Error('A grown case is judged by executing its reference implementation, not by a built-in oracle');
  switch (review.oracle) {
    case 'checkout':
      return Math.round(((args[0] as number) * (args[1] as number) * (100 - (args[2] as number))) / 100);
    case 'agent-tools':
      return args[0] === 'read' || args[1] === true;
    case 'audit-log':
      return `user=${args[0]}`;
    case 'retry-delay':
      return Math.min(30000, 1000 * 2 ** (args[0] as number));
    case 'token-expiry':
      return (args[0] as number) >= (args[1] as number);
    case 'retention':
      return (args[0] as number) >= 30 && args[1] === false;
    case 'search-race':
      return args[0] === args[1];
    case 'leg-count':
      return 6;
  }
}

/** Small, explicit case-specific sweeps. These are not claims of exhaustive verification. */
export function deterministicInputs(review: ReviewCase): Scalar[][] {
  let columns: Scalar[][];
  switch (review.oracle) {
    case null:
      return [];
    case 'reference':
      return (review.sweep ?? []).map(args => [...args]);
    case 'checkout':
      columns = [
        [1, 5, 99, 101],
        [1, 2, 3],
        [0, 10, 50, 100],
      ];
      break;
    case 'agent-tools':
      columns = [
        ['read', 'write', 'bash'],
        [false, true],
      ];
      break;
    case 'audit-log':
      columns = [
        ['alice', 'bob'],
        ['DEMO_KEY_A', 'DEMO_KEY_B'],
      ];
      break;
    case 'retry-delay':
      columns = [Array.from({ length: 11 }, (_, i) => i)];
      break;
    case 'token-expiry':
      columns = [
        [0, 1, 100, 999, 1000, 10000],
        [0, 1, 100, 999, 1000, 10000],
      ];
      break;
    case 'retention':
      columns = [
        [0, 1, 29, 30, 31, 365],
        [false, true],
      ];
      break;
    case 'search-race':
      columns = [
        [1, 2, 50, 100],
        [1, 2, 50, 100],
      ];
      break;
    case 'leg-count':
      columns = [];
      break;
  }
  return columns.reduce<Scalar[][]>((rows, column) => rows.flatMap(row => column.map(value => [...row, value])), [[]]);
}
