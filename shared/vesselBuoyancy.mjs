/**
 * 低成本船只浮力评估。
 *
 * 服务器只在船体结构、货物或部件耐久发生变化时调用，不采样客户端波浪，
 * 也不执行逐浮筒刚体积分。质量与浮力使用同一套游戏单位即可。
 */

export const VESSEL_FLOAT_STATES = Object.freeze({
  AFLOAT: 'afloat',
  OVERLOADED: 'overloaded',
  FLOODING: 'flooding',
  SINKING: 'sinking',
});

const NORMAL_LOAD_LIMIT = 0.85;

function finiteOr(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * @typedef {object} VesselBuoyancyPart
 * @property {number} mass
 * @property {number} buoyancy
 * @property {number} [integrity]
 * @property {number} [localX]
 * @property {number} [localZ]
 */

/**
 * @typedef {object} VesselBuoyancyOptions
 * @property {number} [extraMass]
 * @property {number} [minimumBeam]
 * @property {number} [minimumLength]
 * @property {number} [maximumTrimRadians]
 */

/**
 * @param {readonly VesselBuoyancyPart[]} parts
 * @param {VesselBuoyancyOptions} [options]
 */
export function evaluateVesselBuoyancy(parts, options = {}) {
  let totalMass = Math.max(0, finiteOr(options.extraMass));
  let effectiveBuoyancy = 0;
  let massMomentX = 0;
  let massMomentZ = 0;
  let buoyancyMomentX = 0;
  let buoyancyMomentZ = 0;
  let minimumX = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let minimumZ = Number.POSITIVE_INFINITY;
  let maximumZ = Number.NEGATIVE_INFINITY;

  for (const rawPart of parts) {
    const mass = Math.max(0, finiteOr(rawPart?.mass));
    const buoyancy = Math.max(0, finiteOr(rawPart?.buoyancy));
    const integrity = clamp(finiteOr(rawPart?.integrity, 1), 0, 1);
    const localX = finiteOr(rawPart?.localX);
    const localZ = finiteOr(rawPart?.localZ);
    const availableBuoyancy = buoyancy * integrity;

    totalMass += mass;
    effectiveBuoyancy += availableBuoyancy;
    massMomentX += mass * localX;
    massMomentZ += mass * localZ;
    buoyancyMomentX += availableBuoyancy * localX;
    buoyancyMomentZ += availableBuoyancy * localZ;

    if (availableBuoyancy > 0) {
      minimumX = Math.min(minimumX, localX);
      maximumX = Math.max(maximumX, localX);
      minimumZ = Math.min(minimumZ, localZ);
      maximumZ = Math.max(maximumZ, localZ);
    }
  }

  const loadRatio = effectiveBuoyancy > 0
    ? totalMass / effectiveBuoyancy
    : Number.POSITIVE_INFINITY;
  const centerOfMass = {
    x: totalMass > 0 ? massMomentX / totalMass : 0,
    z: totalMass > 0 ? massMomentZ / totalMass : 0,
  };
  const centerOfBuoyancy = {
    x: effectiveBuoyancy > 0 ? buoyancyMomentX / effectiveBuoyancy : 0,
    z: effectiveBuoyancy > 0 ? buoyancyMomentZ / effectiveBuoyancy : 0,
  };

  const beam = Math.max(
    finiteOr(options.minimumBeam, 1),
    Number.isFinite(minimumX) ? maximumX - minimumX : 0,
  );
  const length = Math.max(
    finiteOr(options.minimumLength, 1),
    Number.isFinite(minimumZ) ? maximumZ - minimumZ : 0,
  );
  const maximumTrim = clamp(finiteOr(options.maximumTrimRadians, 0.1), 0, 0.25);
  const trimRoll = clamp(
    ((centerOfBuoyancy.x - centerOfMass.x) / beam) * maximumTrim,
    -maximumTrim,
    maximumTrim,
  );
  const trimPitch = clamp(
    ((centerOfMass.z - centerOfBuoyancy.z) / length) * maximumTrim,
    -maximumTrim,
    maximumTrim,
  );

  let state;
  if (!(effectiveBuoyancy > 0)) state = VESSEL_FLOAT_STATES.SINKING;
  else if (loadRatio <= NORMAL_LOAD_LIMIT) state = VESSEL_FLOAT_STATES.AFLOAT;
  else if (loadRatio <= 1) state = VESSEL_FLOAT_STATES.OVERLOADED;
  else state = VESSEL_FLOAT_STATES.FLOODING;

  let speedFactor = 0;
  if (state === VESSEL_FLOAT_STATES.AFLOAT) speedFactor = 1;
  else if (state === VESSEL_FLOAT_STATES.OVERLOADED) {
    const overload = (loadRatio - NORMAL_LOAD_LIMIT) / (1 - NORMAL_LOAD_LIMIT);
    speedFactor = 1 - clamp(overload, 0, 1) * 0.35;
  } else if (state === VESSEL_FLOAT_STATES.FLOODING) {
    speedFactor = 0.35;
  }

  return {
    state,
    totalMass,
    effectiveBuoyancy,
    reserveBuoyancy: effectiveBuoyancy - totalMass,
    loadRatio,
    draftRatio: Number.isFinite(loadRatio) ? clamp(loadRatio, 0, 1.15) : 1.15,
    speedFactor,
    centerOfMass,
    centerOfBuoyancy,
    trimRoll,
    trimPitch,
  };
}
