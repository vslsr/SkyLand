function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function recordEvent(buoyancy, type, targetId) {
  buoyancy.eventRevision += 1;
  buoyancy.lastEvent = { type, targetId };
  buoyancy.markDirty();
}

export function addVesselCargo(buoyancy, cargo) {
  if (!cargo.id || buoyancy.loads.some((load) => load.id === cargo.id)) return false;
  buoyancy.loads.push({
    id: cargo.id,
    mass: clamp(Number(cargo.mass) || 0, 0, 1000),
    buoyancy: 0,
    integrity: 1,
    localX: clamp(
      Number(cargo.localX) || 0,
      -buoyancy.minimumBeam * 0.5,
      buoyancy.minimumBeam * 0.5,
    ),
    localZ: clamp(
      Number(cargo.localZ) || 0,
      -buoyancy.minimumLength * 0.5,
      buoyancy.minimumLength * 0.5,
    ),
  });
  recordEvent(buoyancy, 'cargo:add', cargo.id);
  return true;
}

export function removeVesselCargo(buoyancy, cargoId) {
  const index = buoyancy.loads.findIndex((load) => load.id === cargoId);
  if (index < 0) return false;
  buoyancy.loads.splice(index, 1);
  recordEvent(buoyancy, 'cargo:remove', cargoId);
  return true;
}

export function damageVesselPart(buoyancy, partId, amount) {
  const part = buoyancy.parts.find((candidate) => candidate.id === partId);
  if (!part) return false;
  const damage = clamp(Number(amount) || 0, 0, 1);
  if (damage <= 0 || part.integrity <= 0) return false;
  part.integrity = clamp(part.integrity - damage, 0, 1);
  recordEvent(buoyancy, 'damage', partId);
  return true;
}
