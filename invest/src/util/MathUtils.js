// src/util/MathUtils.js
// Pure money + share math. No deps, no DOM.

export const EPS = 1e-9;

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
export const round8 = (n) => Math.round((n + Number.EPSILON) * 1e8) / 1e8;

export function sumValues(obj) {
  let s = 0;
  for (const k in obj) s += obj[k];
  return s;
}

export function approxEqual(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

/**
 * Allocate `total` across `weights = {key: weight}` so that the rounded parts
 * re-sum exactly to `total` (largest-remainder method). No floating-point drift.
 *
 * @param {number} total
 * @param {Record<string, number>} weights
 * @param {number} decimals
 * @returns {Record<string, number>}
 */
export function proratePreservingTotal(total, weights, decimals = 2) {
  const keys = Object.keys(weights);
  const result = {};
  if (keys.length === 0) return result;

  const factor = Math.pow(10, decimals);
  const totalUnits = Math.round(total * factor);

  const sumW = sumValues(weights);
  if (sumW === 0) {
    for (const k of keys) result[k] = 0;
    return result;
  }

  const floors = {};
  const remainders = [];
  let assignedUnits = 0;

  for (const k of keys) {
    const exactUnits = (weights[k] / sumW) * totalUnits;
    const floorUnits = Math.floor(exactUnits);
    floors[k] = floorUnits;
    remainders.push({ k, frac: exactUnits - floorUnits });
    assignedUnits += floorUnits;
  }

  let leftover = totalUnits - assignedUnits;
  remainders.sort((a, b) => b.frac - a.frac);
  for (let i = 0; i < remainders.length && leftover > 0; i++) {
    floors[remainders[i].k] += 1;
    leftover -= 1;
  }

  for (const k of keys) result[k] = floors[k] / factor;
  return result;
}
