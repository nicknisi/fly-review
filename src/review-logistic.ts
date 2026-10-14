import type { Descriptors } from './review-brain.ts';
import { RECEPTOR_KEYS } from './review-odor.ts';

/**
 * The boring alternative. A logistic regression over Jev's thirty descriptors, fit by plain gradient descent with a
 * little L2. It exists so the fly is always compared against the simplest thing that could replace it, on the same
 * inputs and the same split. No dependencies, no tuning beyond the fixed settings below.
 */
export type Logistic = { weights: Record<string, number>; bias: number; iterations: number; l2: number };

export function fitLogistic(
  examples: { features: Descriptors | Record<string, number>; regression: boolean }[],
  options: { iterations?: number; rate?: number; l2?: number; keys?: readonly string[] } = {},
): Logistic {
  const { iterations = 3000, rate = 0.5, l2 = 1e-3, keys = RECEPTOR_KEYS } = options;
  const X = examples.map(e => keys.map(k => (e.features as Record<string, number>)[k] ?? 0));
  const Y = examples.map(e => (e.regression ? 1 : 0));
  const w = new Array<number>(keys.length).fill(0);
  let b = 0;
  const n = Math.max(1, X.length);
  for (let it = 0; it < iterations; it++) {
    const gw = new Array<number>(keys.length).fill(0);
    let gb = 0;
    for (let i = 0; i < X.length; i++) {
      let z = b;
      for (let j = 0; j < keys.length; j++) z += w[j] * X[i][j];
      const error = 1 / (1 + Math.exp(-z)) - Y[i];
      for (let j = 0; j < keys.length; j++) gw[j] += error * X[i][j];
      gb += error;
    }
    for (let j = 0; j < keys.length; j++) w[j] -= rate * (gw[j] / n + l2 * w[j]);
    b -= (rate * gb) / n;
  }
  return { weights: Object.fromEntries(keys.map((k, j) => [k, w[j]])), bias: b, iterations, l2 };
}

/** Probability that the change is a regression, according to the fitted model. */
export function predictLogistic(model: Logistic, features: Descriptors | Record<string, number>): number {
  let z = model.bias;
  for (const [k, w] of Object.entries(model.weights)) z += w * ((features as Record<string, number>)[k] ?? 0);
  return 1 / (1 + Math.exp(-z));
}
