function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function createCharacterState(initial = {}) {
  return {
    x: finite(initial.x),
    y: finite(initial.y),
    z: finite(initial.z),
    vx: finite(initial.vx),
    vy: finite(initial.vy),
    vz: finite(initial.vz),
    grounded: initial.grounded !== false,
    jumpPressed: initial.jumpPressed === true,
  };
}

export function copyCharacterState(target, source) {
  target.x = finite(source?.x);
  target.y = finite(source?.y);
  target.z = finite(source?.z);
  target.vx = finite(source?.vx);
  target.vy = finite(source?.vy);
  target.vz = finite(source?.vz);
  target.grounded = source?.grounded === true;
  target.jumpPressed = source?.jumpPressed === true;
  return target;
}

