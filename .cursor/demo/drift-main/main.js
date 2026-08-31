// DRIFT — a poly ocean
// Third-person low-poly submarine exploration. Flat-shaded poly art,
// layered light shafts, procedural caustics, schooling fish with animated
// tails, mantas, turtles, jellyfish, and a depth-graded cinematic mood.

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ---------------------------------------------------------------- constants

const SURFACE_Y = 34;
const WORLD_R = 220;
const TERRAIN_SIZE = 520;
const TERRAIN_SEGS = 130;

const clock = new THREE.Clock();
const uTime = { value: 0 };

// ------------------------------------------------------------------- noise

function hash2(ix, iz) {
  let n = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n = n ^ (n >>> 16);
  return (n & 0x7fffffff) / 0x7fffffff;
}
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
function fbm(x, z) {
  let f = 0, amp = 1, sum = 0;
  for (let o = 0; o < 4; o++) {
    f += vnoise(x, z) * amp;
    sum += amp; amp *= 0.5;
    x = x * 2.03 + 11.7; z = z * 2.11 + 5.3;
  }
  return f / sum;
}
// a big island in the southwest, rising well out of the water
const ISLAND = { x: -135, z: 135, r: 70 };

function heightAt(x, z) {
  let h = Math.pow(fbm(x * 0.013 + 5.2, z * 0.013 + 1.7), 1.5) * 15;
  h += fbm(x * 0.055, z * 0.055) * 2.4;
  h += Math.sin(x * 0.16 + fbm(x * 0.05, z * 0.05) * 5.0) * 0.4; // sand ripples
  const dx = x - ISLAND.x, dz = z - ISLAND.z;
  const ragged = 0.9 + fbm(x * 0.018 + 3.1, z * 0.018 + 7.7) * 0.28;
  const d = Math.hypot(dx, dz) * ragged;
  if (d < ISLAND.r) {
    const isl = Math.pow(1 - d / ISLAND.r, 0.65); // plateau profile: wide beach
    h += isl * (46 + fbm(x * 0.02 + 13.7, z * 0.02 + 2.9) * 14);
  }
  return h - 3.5;
}
const rng = (() => { let s = 1337; return () => { s = (Math.imul(s, 48271)) % 2147483647; return (s & 0x7fffffff) / 0x7fffffff; }; })();
const rand = (a, b) => a + rng() * (b - a);

// ------------------------------------------------------------------- scene

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x0f5478, 0.0135);

const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 700);
camera.position.set(0, 20, 72);

// ---------------------------------------------------------------- lighting

const sun = new THREE.DirectionalLight(0xc8ecdf, 1.55);
sun.position.set(38, 90, -22);
scene.add(sun);

const hemi = new THREE.HemisphereLight(0x5aa8cf, 0x0a2e40, 0.6);
scene.add(hemi);

const fill = new THREE.DirectionalLight(0x3a7ca8, 0.5);
fill.position.set(-50, 30, 60);
scene.add(fill);

// upward bounce — lights the underside of the water surface
const bounce = new THREE.DirectionalLight(0x9fd8ea, 1.0);
bounce.position.set(30, -60, 10);
scene.add(bounce);

// ------------------------------------------------------------ gradient sky

const skyUniforms = {
  cTop: { value: new THREE.Color(0x3fa7c9) },
  cBottom: { value: new THREE.Color(0x06304a) },
};
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(420, 24, 16),
  new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: /* glsl */`
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 cTop; uniform vec3 cBottom;
      varying vec3 vPos;
      void main() {
        float t = smoothstep(-0.25, 0.55, normalize(vPos).y);
        gl_FragColor = vec4(mix(cBottom, cTop, t), 1.0);
      }`,
  })
);
scene.add(sky);

// ----------------------------------------------------------------- terrain

const causticStrength = { value: 0.42 };

function injectCaustics(material, strengthUniform) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.uniforms.uCaustic = strengthUniform;
    shader.vertexShader = 'varying vec3 vWPos;\n' + shader.vertexShader.replace(
      '#include <project_vertex>',
      '#include <project_vertex>\n vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;'
    );
    shader.fragmentShader = `
      uniform float uTime; uniform float uCaustic;
      varying vec3 vWPos;
      float caustic(vec2 p, float t) {
        vec2 i = p; float c = 1.0; const float inten = 0.005;
        for (int n = 0; n < 4; n++) {
          float tt = t * (1.0 - (3.5 / float(n + 1)));
          i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
          c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
        }
        c /= 4.0;
        c = 1.17 - pow(c, 1.4);
        return pow(abs(c), 8.0);
      }
    ` + shader.fragmentShader.replace(
      '#include <fog_fragment>',
      `float ca = caustic(vWPos.xz * 0.16, uTime * 0.5);
       gl_FragColor.rgb += clamp(ca, 0.0, 1.2) * vec3(0.42, 0.74, 0.78) * uCaustic;
       #include <fog_fragment>`
    );
  };
}

const terrain = (() => {
  let geo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEGS, TERRAIN_SEGS);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
  }
  geo = geo.toNonIndexed();

  const p = geo.attributes.position;
  const colors = new Float32Array(p.count * 3);
  const cSand = new THREE.Color(0xc4a76d);
  const cGrass = new THREE.Color(0x4f9070);
  const cRock = new THREE.Color(0x6d7f8e);
  const cPeak = new THREE.Color(0x93a3b0);
  const cBeach = new THREE.Color(0xd8ca96);
  const cMeadow = new THREE.Color(0x6cae5e);
  const cCliff = new THREE.Color(0x86919b);
  const tmp = new THREE.Color();
  for (let f = 0; f < p.count; f += 3) {
    const hAvg = (p.getY(f) + p.getY(f + 1) + p.getY(f + 2)) / 3;
    const x = p.getX(f), z = p.getZ(f);
    const moss = fbm(x * 0.03 + 9.1, z * 0.03 + 3.7);
    if (hAvg > SURFACE_Y - 6) {
      // island ramp: wet sand -> beach -> meadow -> cliff
      if (hAvg < SURFACE_Y + 2) tmp.copy(cSand).lerp(cBeach, (hAvg - (SURFACE_Y - 6)) / 8);
      else if (hAvg < SURFACE_Y + 5) tmp.copy(cBeach);
      else if (hAvg < SURFACE_Y + 13) tmp.copy(cBeach).lerp(cMeadow, (hAvg - (SURFACE_Y + 5)) / 6);
      else tmp.copy(cMeadow).lerp(cCliff, Math.min(1, (hAvg - (SURFACE_Y + 13)) / 8 + (moss - 0.5)));
    } else if (hAvg < 1.2) {
      tmp.copy(cSand);
      if (moss > 0.62) tmp.lerp(cGrass, (moss - 0.62) * 2.2);
    } else if (hAvg < 5.0) {
      tmp.copy(cSand).lerp(cRock, (hAvg - 1.2) / 3.8);
      if (moss > 0.55) tmp.lerp(cGrass, (moss - 0.55) * 1.4);
    } else {
      tmp.copy(cRock).lerp(cPeak, Math.min(1, (hAvg - 5.0) / 5.0));
    }
    const jit = (hash2(f, 17) - 0.5) * 0.09;
    tmp.offsetHSL(0, 0, jit);
    for (let v = 0; v < 3; v++) {
      colors[(f + v) * 3] = tmp.r;
      colors[(f + v) * 3 + 1] = tmp.g;
      colors[(f + v) * 3 + 2] = tmp.b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0,
  });
  injectCaustics(mat, causticStrength);
  return new THREE.Mesh(geo, mat);
})();
scene.add(terrain);

// ----------------------------------------------------------- water surface

const water = (() => {
  const SEGS = 104, SIZE = 560;
  let geo = new THREE.PlaneGeometry(SIZE, SIZE, SEGS, SEGS);
  geo.rotateX(-Math.PI / 2);
  geo = geo.toNonIndexed();

  // per-face tint: the underside reads as a faceted glass mosaic from any angle
  const p = geo.attributes.position;
  const colors = new Float32Array(p.count * 3);
  const cA = new THREE.Color(0x135575);
  const cB = new THREE.Color(0x72d4ef);
  const tint = new THREE.Color();
  for (let f = 0; f < p.count; f += 3) {
    const x = p.getX(f), z = p.getZ(f);
    const n = fbm(x * 0.04 + 31.7, z * 0.04 + 8.9);
    tint.lerpColors(cA, cB, THREE.MathUtils.clamp(n * 1.1 + (hash2(f, 91) - 0.5) * 0.85, 0, 1));
    for (let v = 0; v < 3; v++) {
      colors[(f + v) * 3] = tint.r;
      colors[(f + v) * 3 + 1] = tint.g;
      colors[(f + v) * 3 + 2] = tint.b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xbfd9e2,
    vertexColors: true,
    emissive: 0x2a7fa8,
    emissiveIntensity: 0.32,
    roughness: 0.18,
    metalness: 0.2,
    transparent: true,
    opacity: 0.82,
    side: THREE.DoubleSide,
    flatShading: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = SURFACE_Y;

  // all wave terms are separable in x/z: per-axis trig tables fill a grid,
  // which fans out to the non-indexed vertices through a precomputed map
  const G = SEGS + 1;
  const idxMap = new Uint32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const xi = Math.round((p.getX(i) + SIZE / 2) / SIZE * SEGS);
    const zi = Math.round((p.getZ(i) + SIZE / 2) / SIZE * SEGS);
    idxMap[i] = zi * G + xi;
  }
  mesh.userData = { G, idxMap, gridH: new Float32Array(G * G), axis: new Float32Array(G) };
  const axis = mesh.userData.axis;
  for (let i = 0; i < G; i++) axis[i] = -SIZE / 2 + (i / SEGS) * SIZE;
  return mesh;
})();
scene.add(water);

const wTab = { t1: null, t2: null, sx: null, cx: null, sz: null, cz: null, x4: null, z4: null, t5: null, t6: null };
function animateWater(t) {
  const { G, idxMap, gridH, axis } = water.userData;
  if (!wTab.t1) for (const k in wTab) wTab[k] = new Float32Array(G);
  for (let i = 0; i < G; i++) {
    const x = axis[i], z = axis[i];
    wTab.t1[i] = Math.sin(x * 0.055 + t * 0.9) * 1.1;
    wTab.t2[i] = Math.cos(z * 0.045 + t * 0.7) * 0.9;
    wTab.sx[i] = Math.sin(x * 0.03) * 0.7; wTab.cx[i] = Math.cos(x * 0.03) * 0.7;
    wTab.sz[i] = Math.sin(z * 0.03 + t * 0.45); wTab.cz[i] = Math.cos(z * 0.03 + t * 0.45);
    wTab.x4[i] = Math.sin(x * 0.21 + t * 1.3) * 0.7; wTab.z4[i] = Math.cos(z * 0.18 + t * 1.1);
    wTab.t5[i] = Math.sin(x * 0.33 - t * 1.7) * 0.35;
    wTab.t6[i] = Math.cos(z * 0.29 + t * 1.5) * 0.35;
  }
  for (let zi = 0, g = 0; zi < G; zi++) {
    for (let xi = 0; xi < G; xi++, g++) {
      gridH[g] =
        wTab.t1[xi] + wTab.t2[zi] +
        (wTab.sx[xi] * wTab.cz[zi] + wTab.cx[xi] * wTab.sz[zi]) +
        wTab.x4[xi] * wTab.z4[zi] +
        wTab.t5[xi] + wTab.t6[zi];
    }
  }
  const arr = water.geometry.attributes.position.array;
  for (let i = 0; i < idxMap.length; i++) arr[i * 3 + 1] = gridH[idxMap[i]];
  water.geometry.attributes.position.needsUpdate = true;
  // no computeVertexNormals: flat-shaded materials derive normals per-fragment
}

// sun glow under the surface — bloom catches this
function radialTexture(stops) {
  const cnv = document.createElement('canvas');
  cnv.width = cnv.height = 128;
  const ctx = cnv.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (const [o, c] of stops) g.addColorStop(o, c);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(cnv);
}
const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
  map: radialTexture([[0, 'rgba(255,244,214,1)'], [0.25, 'rgba(190,235,240,0.55)'], [1, 'rgba(140,210,230,0)']]),
  blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.95, fog: false,
}));
sunGlow.scale.setScalar(85);
sunGlow.position.set(85, SURFACE_Y - 4, -50);
scene.add(sunGlow);

const sunHalo = new THREE.Sprite(new THREE.SpriteMaterial({
  map: radialTexture([[0, 'rgba(170,225,235,0.5)'], [1, 'rgba(140,210,230,0)']]),
  blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.5, fog: false,
}));
sunHalo.scale.setScalar(190);
sunHalo.position.copy(sunGlow.position);
scene.add(sunHalo);

// the real sun, high in the sky along the light direction: hard hot core,
// warm corona, wide glow — bloom turns it into a proper star
const skySun = new THREE.Sprite(new THREE.SpriteMaterial({
  map: radialTexture([
    [0, 'rgba(255,255,248,1)'], [0.16, 'rgba(255,250,225,1)'],
    [0.22, 'rgba(255,238,185,0.5)'], [0.45, 'rgba(255,225,165,0.16)'],
    [1, 'rgba(255,215,150,0)'],
  ]),
  blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
  transparent: true, opacity: 0.2, fog: false,
}));
skySun.scale.setScalar(150);
skySun.position.copy(sun.position).normalize().multiplyScalar(360);
scene.add(skySun);

// low-poly clouds drifting high above the water
const clouds = new THREE.Group();
{
  const cloudMat = new THREE.MeshStandardMaterial({
    color: 0xf7fbfd, roughness: 1, flatShading: true,
    emissive: 0xdfeef5, emissiveIntensity: 0.25,
  });
  for (let i = 0; i < 9; i++) {
    const cl = new THREE.Group();
    const puffs = 3 + Math.floor(rng() * 3);
    for (let k = 0; k < puffs; k++) {
      const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 0), cloudMat);
      puff.position.set(k * rand(4, 6) - puffs * 2.5, rand(-1, 1.5), rand(-2.5, 2.5));
      puff.scale.set(rand(4, 7), rand(1.8, 2.8), rand(3, 5));
      puff.rotation.y = rand(0, Math.PI);
      cl.add(puff);
    }
    const a = rand(0, Math.PI * 2), r = rand(90, 290);
    cl.position.set(Math.cos(a) * r, rand(75, 130), Math.sin(a) * r);
    cl.userData.speed = rand(0.8, 1.8);
    clouds.add(cl);
  }
}
scene.add(clouds);

// ----------------------------------------------------------- light shafts
// Crossed translucent blades hanging from the surface: soft horizontal
// edges, vertical fade, slow drifting streaks. Reads as volumetric light
// from any angle, not as "cones".

const shaftMaterial = (phase, intensity) => new THREE.ShaderMaterial({
  uniforms: {
    uTime,
    uPhase: { value: phase },
    uIntensity: { value: intensity },
    uColor: { value: new THREE.Color(0xcdeee6) },
  },
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
  fog: false,
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform float uTime; uniform float uPhase; uniform float uIntensity; uniform vec3 uColor;
    varying vec2 vUv;
    void main() {
      float edge = smoothstep(0.0, 0.24, vUv.x) * smoothstep(1.0, 0.76, vUv.x);
      float fade = pow(vUv.y, 2.3);
      // two drifting streak frequencies make the shaft feel alive
      float s1 = 0.62 + 0.38 * sin(vUv.x * 21.0 - uTime * 0.4 + uPhase);
      float s2 = 0.75 + 0.25 * sin(vUv.x * 47.0 + uTime * 0.27 + uPhase * 2.3);
      float breathe = 0.7 + 0.3 * sin(uTime * 0.33 + uPhase * 1.7);
      float a = edge * fade * s1 * s2 * breathe * uIntensity;
      gl_FragColor = vec4(uColor, a);
    }`,
});

const shafts = new THREE.Group();
{
  const H = SURFACE_Y + 10;
  for (let i = 0; i < 9; i++) {
    const group = new THREE.Group();
    const w = rand(7, 18);
    const phase = rand(0, Math.PI * 2);
    const intensity = rand(0.3, 0.5);
    for (let k = 0; k < 2; k++) {
      const blade = new THREE.Mesh(new THREE.PlaneGeometry(w, H), shaftMaterial(phase + k * 1.3, intensity));
      blade.rotation.y = k * Math.PI / 2;
      group.add(blade);
    }
    const a = rand(0, Math.PI * 2), r = rand(6, 110);
    group.position.set(Math.cos(a) * r, H / 2 - 4, Math.sin(a) * r);
    group.rotation.y = rand(0, Math.PI);
    group.rotation.z = -0.14;
    group.rotation.x = 0.05;
    group.userData.sway = rand(0.4, 1.1);
    group.userData.phase = phase;
    shafts.add(group);
  }
}
scene.add(shafts);

// ------------------------------------------------------------------- kelp

const kelpMat = new THREE.MeshStandardMaterial({
  color: 0x4fae74, roughness: 0.85, flatShading: true,
  emissive: 0x2f7a50, emissiveIntensity: 0.4,
});
kelpMat.onBeforeCompile = (shader) => {
  shader.uniforms.uTime = uTime;
  shader.vertexShader = ('uniform float uTime;\n' + shader.vertexShader).replace(
    '#include <begin_vertex>',
    `#include <begin_vertex>
     vec3 ipos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
     float bend = pow(max(transformed.y, 0.0) / 13.0, 1.6);
     transformed.x += sin(uTime * 0.8 + ipos.x * 0.35 + ipos.z * 0.27) * bend * 2.6;
     transformed.z += cos(uTime * 0.6 + ipos.x * 0.21 + ipos.z * 0.43) * bend * 1.7;`
  );
};

const kelp = (() => {
  const geo = new THREE.CylinderGeometry(0.16, 0.62, 13, 5, 7, false);
  geo.translate(0, 6.5, 0);
  const count = 150;
  const mesh = new THREE.InstancedMesh(geo, kelpMat, count);
  const dummy = new THREE.Object3D();
  let placed = 0;
  while (placed < count) {
    const ca = rand(0, Math.PI * 2), cr = rand(20, 170);
    const cx = Math.cos(ca) * cr, cz = Math.sin(ca) * cr;
    const strands = Math.min(count - placed, 4 + Math.floor(rng() * 6));
    for (let s = 0; s < strands; s++) {
      const x = cx + rand(-7, 7), z = cz + rand(-7, 7);
      const y = heightAt(x, z);
      if (y > 6) continue;
      if (Math.hypot(x, z - 56) < 22) continue; // keep the spawn view clear
      dummy.position.set(x, y - 0.3, z);
      dummy.rotation.y = rand(0, Math.PI * 2);
      dummy.scale.set(rand(0.7, 1.3), rand(0.7, 1.7), rand(0.7, 1.3));
      dummy.updateMatrix();
      mesh.setMatrixAt(placed++, dummy.matrix);
      if (placed >= count) break;
    }
  }
  return mesh;
})();
scene.add(kelp);

// ------------------------------------------------------------ coral & rock

function scatterOnFloor(mesh, count, opts = {}) {
  const { rMin = 12, rMax = 185, sMin = 0.6, sMax = 1.6, maxH = 5.5, sink = 0.25 } = opts;
  const dummy = new THREE.Object3D();
  let i = 0, guard = 0;
  while (i < count && guard++ < count * 30) {
    const a = rand(0, Math.PI * 2), r = rand(rMin, rMax);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (Math.hypot(x, z - 56) < 18) continue; // keep the spawn view clear
    const y = heightAt(x, z);
    if (y > maxH) continue;
    dummy.position.set(x, y - sink, z);
    dummy.rotation.set(rand(-0.12, 0.12), rand(0, Math.PI * 2), rand(-0.12, 0.12));
    const s = rand(sMin, sMax);
    dummy.scale.set(s * rand(0.85, 1.15), s, s * rand(0.85, 1.15));
    dummy.updateMatrix();
    mesh.setMatrixAt(i++, dummy.matrix);
  }
  mesh.count = i;
  return mesh;
}

function branchCoralGeometry() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.13, 0.3, 1.6, 5);
  trunk.translate(0, 0.8, 0);
  parts.push(trunk);
  const branches = 5;
  for (let b = 0; b < branches; b++) {
    const len = rand(1.0, 1.9);
    const g = new THREE.CylinderGeometry(0.05, 0.16, len, 4);
    g.translate(0, len / 2, 0);
    const m = new THREE.Matrix4()
      .makeRotationFromEuler(new THREE.Euler(rand(0.4, 0.95), (b / branches) * Math.PI * 2, 0, 'YXZ'))
      .setPosition(0, rand(0.9, 1.5), 0);
    g.applyMatrix4(m);
    parts.push(g);
  }
  return BufferGeometryUtils.mergeGeometries(parts);
}

const coralPalette = [0xff6f91, 0xff9a5c, 0xb07cf7, 0x35d0ba, 0xf7c95c];
const corals = new THREE.Group();
for (let v = 0; v < 5; v++) {
  const color = coralPalette[v];
  const mat = new THREE.MeshStandardMaterial({
    color, roughness: 0.7, flatShading: true,
    emissive: color, emissiveIntensity: 0.14,
  });
  let geo;
  if (v % 3 === 0) geo = branchCoralGeometry();
  else if (v % 3 === 1) { geo = new THREE.IcosahedronGeometry(0.9, 1); geo.scale(1.2, 0.75, 1.2); }
  else {
    const tubes = [];
    for (let tI = 0; tI < 5; tI++) {
      const h = rand(0.7, 1.7);
      const g = new THREE.CylinderGeometry(rand(0.14, 0.24), rand(0.2, 0.3), h, 6, 1, false);
      g.translate(rand(-0.5, 0.5), h / 2, rand(-0.5, 0.5));
      tubes.push(g);
    }
    geo = BufferGeometryUtils.mergeGeometries(tubes);
  }
  const inst = new THREE.InstancedMesh(geo, mat, 30);
  scatterOnFloor(inst, 30, { sMin: 0.8, sMax: 2.4, maxH: 4.0 });
  corals.add(inst);
}
scene.add(corals);

const rocks = (() => {
  const geo = new THREE.DodecahedronGeometry(1, 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0x5e7282, roughness: 1, flatShading: true });
  const inst = new THREE.InstancedMesh(geo, mat, 90);
  scatterOnFloor(inst, 90, { sMin: 0.5, sMax: 3.4, maxH: 9, sink: 0.5 });
  return inst;
})();
scene.add(rocks);

const boulders = (() => {
  const geo = new THREE.DodecahedronGeometry(1, 1);
  const mat = new THREE.MeshStandardMaterial({ color: 0x55687a, roughness: 1, flatShading: true });
  const inst = new THREE.InstancedMesh(geo, mat, 10);
  scatterOnFloor(inst, 10, { rMin: 40, sMin: 4, sMax: 8, maxH: 7, sink: 1.5 });
  return inst;
})();
scene.add(boulders);

// distant seamount silhouettes (tops stay below the surface)
for (let i = 0; i < 7; i++) {
  const h = rand(26, 42);
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(rand(34, 64), h, 6),
    new THREE.MeshStandardMaterial({ color: 0x274b63, roughness: 1, flatShading: true })
  );
  const a = (i / 7) * Math.PI * 2 + rand(-0.3, 0.3);
  const r = rand(230, 310);
  cone.position.set(Math.cos(a) * r, h / 2 - 14, Math.sin(a) * r);
  cone.rotation.y = rand(0, Math.PI);
  scene.add(cone);
}

// ------------------------------------------------------------------- fish
// Detailed poly fish: two-cone body, forked tail, dorsal and pectoral fins.
// Fins are tinted darker via vertex colors; each instance gets its own hue
// via instanceColor; tails swim via a vertex-shader bend on the rear half.

function finTriangle(a, b, c) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c], 3));
  geo.computeVertexNormals();
  return geo;
}

function tagColor(geo, v) {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = v; arr[i * 3 + 1] = v; arr[i * 3 + 2] = v; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function fishGeometry() {
  const parts = [];
  // body: nose cone + tail cone sharing a base
  const nose = new THREE.ConeGeometry(0.34, 0.6, 6);
  nose.rotateX(Math.PI / 2); nose.translate(0, 0, 0.3);
  const rear = new THREE.ConeGeometry(0.34, 1.1, 6);
  rear.rotateX(-Math.PI / 2); rear.translate(0, 0, -0.55);
  parts.push(tagColor(nose, 1), tagColor(rear, 1));
  // forked tail (vertical V)
  parts.push(tagColor(finTriangle([0, 0, -1.0], [0, 0.5, -1.55], [0, 0.1, -1.3], ), 0.68));
  parts.push(tagColor(finTriangle([0, 0, -1.0], [0, -0.5, -1.55], [0, -0.1, -1.3]), 0.68));
  // dorsal fin
  parts.push(tagColor(finTriangle([0, 0.3, 0.15], [0, 0.66, -0.3], [0, 0.28, -0.5]), 0.68));
  // pectoral fins
  const pL = finTriangle([0.28, -0.05, 0.15], [0.62, -0.28, -0.15], [0.3, -0.08, -0.25]);
  const pR = finTriangle([-0.28, -0.05, 0.15], [-0.62, -0.28, -0.15], [-0.3, -0.08, -0.25]);
  parts.push(tagColor(pL, 0.68), tagColor(pR, 0.68));
  // normalize: non-indexed, position+normal+color only, so merge succeeds
  const norm = parts.map((g) => {
    if (g.index) g = g.toNonIndexed();
    g.deleteAttribute('uv');
    return g;
  });
  return BufferGeometryUtils.mergeGeometries(norm);
}

const fishMat = new THREE.MeshStandardMaterial({
  color: 0xffffff, roughness: 0.55, metalness: 0.25,
  flatShading: true, vertexColors: true, side: THREE.DoubleSide,
});
fishMat.onBeforeCompile = (shader) => {
  shader.uniforms.uTime = uTime;
  shader.vertexShader = ('uniform float uTime;\n' + shader.vertexShader).replace(
    '#include <begin_vertex>',
    `#include <begin_vertex>
     float fphase = instanceMatrix[3][0] * 1.7 + instanceMatrix[3][2] * 2.3;
     float ftail = smoothstep(0.1, -1.4, transformed.z);
     transformed.x += sin(uTime * 7.0 + fphase) * ftail * 0.22;`
  );
};

const fishGeo = fishGeometry();
const schools = [];
const schoolDefs = [
  { color: 0xff8c42, count: 55, center: [35, 14, -25], radii: [38, 4, 30], speed: 0.30, size: [0.65, 1.0], spread: 4.5 },
  { color: 0x4cc9f0, count: 70, center: [-45, 20, 25], radii: [44, 6, 36], speed: 0.24, size: [0.5, 0.8], spread: 5.5 },
  { color: 0xffd166, count: 40, center: [5, 9, 55], radii: [30, 3, 42], speed: 0.36, size: [0.7, 1.1], spread: 3.8 },
  { color: 0xc7d3da, count: 60, center: [-15, 25, -60], radii: [50, 5, 40], speed: 0.20, size: [0.55, 0.85], spread: 6.0 },
  // tight swirls around the landmarks
  { color: 0xaec6d6, count: 45, center: [-85, 12, -45], radii: [14, 3, 12], speed: 0.55, size: [0.45, 0.7], spread: 2.6 },
  { color: 0xff6b6b, count: 45, center: [75, 13, 70], radii: [13, 4, 11], speed: 0.48, size: [0.5, 0.75], spread: 2.4 },
];

const baseHSL = { h: 0, s: 0, l: 0 };
for (const def of schoolDefs) {
  const mesh = new THREE.InstancedMesh(fishGeo, fishMat, def.count);
  mesh.frustumCulled = false;
  new THREE.Color(def.color).getHSL(baseHSL);
  const c = new THREE.Color();
  const members = [];
  for (let i = 0; i < def.count; i++) {
    members.push({
      lag: i * rand(0.015, 0.03),
      off: new THREE.Vector3(rand(-1, 1), rand(-0.6, 0.6), rand(-1, 1)).multiplyScalar(def.spread),
      wob: rand(0, Math.PI * 2),
      wobSpeed: rand(2.2, 3.6),
      scale: rand(def.size[0], def.size[1]),
    });
    c.setHSL(
      (baseHSL.h + rand(-0.025, 0.025) + 1) % 1,
      THREE.MathUtils.clamp(baseHSL.s + rand(-0.1, 0.1), 0, 1),
      THREE.MathUtils.clamp(baseHSL.l + rand(-0.08, 0.08), 0, 1)
    );
    mesh.setColorAt(i, c);
  }
  mesh.instanceColor.needsUpdate = true;
  schools.push({ def, mesh, members, phase: rand(0, Math.PI * 2) });
  scene.add(mesh);
}

const fishDummy = new THREE.Object3D();
const pA = new THREE.Vector3(), pB = new THREE.Vector3();

function schoolPos(def, phase, a, out) {
  out.set(
    def.center[0] + Math.cos(a) * def.radii[0],
    def.center[1] + Math.sin(a * 0.7 + phase) * def.radii[1],
    def.center[2] + Math.sin(a) * def.radii[2]
  );
}

function animateFish(t) {
  for (const s of schools) {
    const { def, mesh, members, phase } = s;
    const a0 = t * def.speed + phase;
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      const a = a0 - m.lag * 30 * def.speed;
      schoolPos(def, phase, a, pA);
      schoolPos(def, phase, a + 0.04, pB);
      const wob = Math.sin(t * m.wobSpeed + m.wob);
      fishDummy.position.set(
        pA.x + m.off.x + wob * 0.4,
        Math.max(pA.y + m.off.y + Math.cos(t * m.wobSpeed * 0.7 + m.wob) * 0.35, 2.5),
        pA.z + m.off.z + wob * 0.3
      );
      pB.add(m.off);
      pB.y = Math.max(pB.y, 2.5);
      fishDummy.lookAt(pB.x + wob * 0.4, fishDummy.position.y, pB.z + wob * 0.3);
      fishDummy.rotation.z = wob * 0.18;
      fishDummy.scale.setScalar(m.scale);
      fishDummy.updateMatrix();
      mesh.setMatrixAt(i, fishDummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ mantas

function mantaGeometry() {
  const v = [
    [0, 0.25, 3.2],     // 0 nose
    [-1.6, 0.1, 1.6],   // 1 left shoulder
    [1.6, 0.1, 1.6],    // 2 right shoulder
    [-6.8, 0.0, -0.8],  // 3 left wingtip
    [6.8, 0.0, -0.8],   // 4 right wingtip
    [-1.3, 0.05, -2.2], // 5 left hip
    [1.3, 0.05, -2.2],  // 6 right hip
    [0, 0.0, -5.6],     // 7 tail tip
    [0, 0.85, 0.0],     // 8 back hump
    [-3.9, 0.05, 0.6],  // 9 left mid-wing leading
    [3.9, 0.05, 0.6],   // 10 right mid-wing leading
    [-0.5, 0.2, 3.0],   // 11 left cephalic fin
    [0.5, 0.2, 3.0],    // 12 right cephalic fin
  ];
  const faces = [
    [0, 1, 8], [0, 8, 2],
    [1, 9, 5], [9, 3, 5],
    [1, 5, 8],
    [2, 8, 6], [2, 6, 10], [10, 6, 4],
    [8, 5, 7], [8, 7, 6],
    [0, 11, 1], [0, 2, 12],
  ];
  const positions = [];
  for (const f of faces) for (const idx of f) positions.push(...v[idx]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

const mantas = [];
const mantaDefs = [
  { radius: 62, height: 22, speed: 0.085, dir: 1, scale: 1.6, phase: 0 },
  { radius: 88, height: 27, speed: 0.06, dir: -1, scale: 2.2, phase: 2.5 },
];
for (const def of mantaDefs) {
  const geo = mantaGeometry();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: 0x52748c, roughness: 0.8, flatShading: true, side: THREE.DoubleSide,
  }));
  mesh.scale.setScalar(def.scale);
  mesh.userData.base = geo.attributes.position.array.slice();
  mantas.push({ def, mesh });
  scene.add(mesh);
}

function animateMantas(t) {
  for (const { def, mesh } of mantas) {
    const a = t * def.speed * def.dir + def.phase;
    const x = Math.cos(a) * def.radius;
    const z = Math.sin(a) * def.radius;
    const y = def.height + Math.sin(t * 0.3 + def.phase) * 3;
    mesh.position.set(x, y, z);
    const a2 = a + 0.05 * def.dir;
    mesh.lookAt(Math.cos(a2) * def.radius, y + Math.cos(t * 0.3 + def.phase) * 0.4, Math.sin(a2) * def.radius);
    mesh.rotateZ(-0.35 * def.dir);

    const pos = mesh.geometry.attributes.position;
    const base = mesh.userData.base;
    for (let i = 0; i < pos.count; i++) {
      const bx = base[i * 3], by = base[i * 3 + 1];
      const w = Math.pow(Math.abs(bx) / 6.8, 1.5);
      pos.array[i * 3 + 1] = by + Math.sin(t * 1.7 + def.phase - Math.abs(bx) * 0.35) * w * 2.4;
    }
    pos.needsUpdate = true; // flat shading derives normals per-fragment
  }
}

// ----------------------------------------------------------------- turtles

function makeTurtle() {
  const g = new THREE.Group();
  const shellMat = new THREE.MeshStandardMaterial({ color: 0x5d8a52, roughness: 0.85, flatShading: true });
  const skinMat = new THREE.MeshStandardMaterial({ color: 0x9aa86a, roughness: 0.9, flatShading: true });
  const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), shellMat);
  shell.scale.set(1.1, 0.5, 1.4);
  g.add(shell);
  const belly = new THREE.Mesh(new THREE.IcosahedronGeometry(0.95, 0), skinMat);
  belly.scale.set(1.0, 0.3, 1.3);
  belly.position.y = -0.18;
  g.add(belly);
  const head = new THREE.Mesh(new THREE.DodecahedronGeometry(0.34, 0), skinMat);
  head.position.set(0, 0.05, 1.55);
  g.add(head);
  const flippers = [];
  const finGeo = new THREE.ConeGeometry(0.28, 1.3, 4);
  finGeo.scale(1, 1, 0.3);
  for (const [sx, sz, front] of [[-1, 0.7, 1], [1, 0.7, 1], [-0.8, -0.8, 0], [0.8, -0.8, 0]]) {
    const f = new THREE.Mesh(finGeo, skinMat);
    f.position.set(sx * 1.0, -0.05, sz);
    f.rotation.z = sx > 0 ? -Math.PI / 2 : Math.PI / 2;
    f.scale.setScalar(front ? 1 : 0.65);
    f.userData = { sx, front };
    g.add(f);
    flippers.push(f);
  }
  g.userData.flippers = flippers;
  return g;
}

const turtles = [];
const turtleDefs = [
  { radius: 48, height: 12, speed: 0.07, dir: -1, scale: 1.3, phase: 1.2 },
  { radius: 105, height: 17, speed: 0.05, dir: 1, scale: 1.7, phase: 4.0 },
];
for (const def of turtleDefs) {
  const t = makeTurtle();
  t.scale.setScalar(def.scale);
  turtles.push({ def, mesh: t });
  scene.add(t);
}

function animateTurtles(t) {
  for (const { def, mesh } of turtles) {
    const a = t * def.speed * def.dir + def.phase;
    const x = Math.cos(a) * def.radius;
    const z = Math.sin(a) * def.radius;
    const y = def.height + Math.sin(t * 0.25 + def.phase) * 2;
    mesh.position.set(x, y, z);
    const a2 = a + 0.05 * def.dir;
    mesh.lookAt(Math.cos(a2) * def.radius, y, Math.sin(a2) * def.radius);
    mesh.rotateZ(-0.15 * def.dir);
    for (const f of mesh.userData.flippers) {
      f.rotation.x = Math.sin(t * 2.1 + def.phase + (f.userData.front ? 0 : 1.4)) * 0.5 * f.userData.sx;
    }
  }
}

// --------------------------------------------------------------- jellyfish

const jellies = [];
{
  const domeGeo = new THREE.SphereGeometry(1, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2);
  const palette = [0xff9ecf, 0x9be8ff, 0xc9a7ff];
  for (let i = 0; i < 16; i++) {
    const color = palette[i % palette.length];
    const g = new THREE.Group();
    const dome = new THREE.Mesh(domeGeo, new THREE.MeshStandardMaterial({
      color, roughness: 0.4, flatShading: true,
      transparent: true, opacity: 0.55, depthWrite: false,
      emissive: color, emissiveIntensity: 0.55, side: THREE.DoubleSide,
    }));
    g.add(dome);
    const tentMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.35, depthWrite: false,
    });
    const tents = [];
    for (let k = 0; k < 5; k++) {
      const tent = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.05, 2.2, 3), tentMat);
      tent.position.set(rand(-0.5, 0.5), -1.1, rand(-0.5, 0.5));
      g.add(tent);
      tents.push(tent);
    }
    const a = rand(0, Math.PI * 2), r = rand(15, 150);
    g.position.set(Math.cos(a) * r, rand(8, 26), Math.sin(a) * r);
    const s = rand(0.5, 1.2);
    g.scale.setScalar(s);
    jellies.push({ g, dome, tents, phase: rand(0, Math.PI * 2), rise: rand(0.25, 0.55), drift: rand(0, Math.PI * 2) });
    scene.add(g);
  }
}

function animateJellies(dt, t) {
  for (const j of jellies) {
    const pulse = Math.sin(t * 1.6 + j.phase);
    j.dome.scale.set(1 + pulse * 0.12, 1 - pulse * 0.18, 1 + pulse * 0.12);
    j.g.position.y += (j.rise + Math.max(0, pulse) * 0.5) * dt;
    j.g.position.x += Math.sin(t * 0.2 + j.drift) * dt * 0.4;
    j.g.position.z += Math.cos(t * 0.17 + j.drift) * dt * 0.4;
    j.g.rotation.y += dt * 0.1;
    if (j.g.position.y > SURFACE_Y - 4) {
      j.g.position.y = Math.max(heightAt(j.g.position.x, j.g.position.z) + 3, 4);
    }
    for (let k = 0; k < j.tents.length; k++) {
      j.tents[k].rotation.x = Math.sin(t * 1.1 + j.phase + k) * 0.18;
      j.tents[k].rotation.z = Math.cos(t * 0.9 + j.phase + k * 2) * 0.18;
    }
  }
}

// ---------------------------------------------------------- landmarks
// Things worth steering toward: a shipwreck, sunken ruins, hydrothermal
// vents, a crystal garden, a giant clam. Each sits on the seafloor at its
// site's actual height.

const woodMat = new THREE.MeshStandardMaterial({ color: 0x5b4632, roughness: 1, flatShading: true });
const woodDark = new THREE.MeshStandardMaterial({ color: 0x3e3226, roughness: 1, flatShading: true });
const stoneMat = new THREE.MeshStandardMaterial({ color: 0x8d97a4, roughness: 1, flatShading: true });
const stoneOld = new THREE.MeshStandardMaterial({ color: 0x6f7d85, roughness: 1, flatShading: true });

// --- shipwreck at (-85, -45)
const wreck = (() => {
  const g = new THREE.Group();
  const hullGeo = new THREE.CylinderGeometry(3.4, 3.4, 16, 9, 1, true, 0, Math.PI);
  hullGeo.rotateZ(Math.PI / 2);   // axis along X
  hullGeo.rotateY(Math.PI / 2);   // axis along Z, opening up
  const hull = new THREE.Mesh(hullGeo, woodMat);
  hull.material = new THREE.MeshStandardMaterial({ color: 0x5b4632, roughness: 1, flatShading: true, side: THREE.DoubleSide });
  hull.rotation.z = Math.PI;      // shell under, deck open to the sky
  hull.position.y = 2.4;
  g.add(hull);

  const deck = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.35, 15.2), woodDark);
  deck.position.y = 1.1;
  g.add(deck);

  const bow = new THREE.Mesh(new THREE.ConeGeometry(3.3, 4.5, 9), woodMat);
  bow.rotation.x = Math.PI / 2;
  bow.position.set(0, 2.2, 10.0);
  g.add(bow);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(4.2, 2.4, 3.2), woodMat);
  cabin.position.set(0, 2.6, -5.5);
  g.add(cabin);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.3, 3.8), woodDark);
  roof.position.set(0, 3.9, -5.5);
  g.add(roof);

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 13, 5), woodDark);
  mast.position.set(0.4, 5.2, 2);
  mast.rotation.z = 0.78; // snapped, leaning hard over the rail
  g.add(mast);
  const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 6.5, 4), woodDark);
  yard.position.set(3.6, 8.0, 2);
  yard.rotation.set(0.3, 0, 2.2);
  g.add(yard);

  // cargo
  for (let i = 0; i < 6; i++) {
    const s = rand(0.7, 1.3);
    const crate = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), i % 2 ? woodMat : woodDark);
    const a = rand(0, Math.PI * 2), r = rand(3, 9);
    crate.position.set(Math.cos(a) * r * 0.6, 1.4 + s / 2 - 0.6, Math.sin(a) * r);
    crate.rotation.y = rand(0, Math.PI);
    g.add(crate);
  }

  // treasure chest with a soft gold spill
  const chest = new THREE.Group();
  chest.add(new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.9, 1.0), woodDark));
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.55, 6, 1, false, 0, Math.PI), woodDark);
  lid.rotation.z = Math.PI / 2;
  lid.rotation.x = -0.9;
  lid.position.set(0, 0.55, -0.45);
  chest.add(lid);
  const gold = new THREE.Mesh(new THREE.SphereGeometry(0.55, 7, 5), new THREE.MeshStandardMaterial({
    color: 0xffd95e, emissive: 0xffb83d, emissiveIntensity: 0.9, roughness: 0.35, metalness: 0.6, flatShading: true,
  }));
  gold.scale.y = 0.5;
  gold.position.y = 0.45;
  chest.add(gold);
  const goldLight = new THREE.PointLight(0xffc24f, 60, 14, 2);
  goldLight.position.y = 1.2;
  chest.add(goldLight);
  chest.position.set(1.6, 1.7, 4.5);
  chest.rotation.y = -0.6;
  g.add(chest);

  g.position.set(-85, heightAt(-85, -45) - 1.4, -45);
  g.rotation.set(0.06, 0.7, 0.14); // settled crooked into the sand
  return g;
})();
scene.add(wreck);

// --- sunken ruins at (75, 70)
const ruins = (() => {
  const g = new THREE.Group();
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(9.5, 11, 1.6, 8), stoneOld);
  plinth.position.y = 0.4;
  g.add(plinth);
  const step = new THREE.Mesh(new THREE.CylinderGeometry(12, 14, 2.2, 8), stoneOld);
  step.position.y = -0.9;
  g.add(step);

  const colGeo = new THREE.CylinderGeometry(0.85, 1.0, 1, 7);
  const capGeo = new THREE.BoxGeometry(2.3, 0.55, 2.3);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const broken = i % 3 === 0;
    const h = broken ? rand(2, 4.5) : rand(7.5, 9);
    const col = new THREE.Mesh(colGeo, i % 2 ? stoneMat : stoneOld);
    col.scale.y = h;
    col.position.set(Math.cos(a) * 7.6, 1.2 + h / 2, Math.sin(a) * 7.6);
    col.rotation.set(rand(-0.04, 0.04), 0, rand(-0.04, 0.04));
    g.add(col);
    if (!broken) {
      const cap = new THREE.Mesh(capGeo, stoneMat);
      cap.position.set(Math.cos(a) * 7.6, 1.2 + h + 0.3, Math.sin(a) * 7.6);
      g.add(cap);
    }
  }
  // one column toppled across the steps
  const fallen = new THREE.Mesh(colGeo, stoneMat);
  fallen.scale.y = 7;
  fallen.rotation.set(0, 0, Math.PI / 2 - 0.08);
  fallen.position.set(2, 1.6, 13.5);
  g.add(fallen);

  // entry gate spanning the plinth edge
  const arch = new THREE.Mesh(new THREE.TorusGeometry(5.2, 0.8, 6, 13, Math.PI), stoneMat);
  arch.position.set(-8.0, 1.6, 0);
  arch.rotation.y = Math.PI / 2;
  g.add(arch);

  // the relic: a slowly bobbing glowing orb
  const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.85, 1), new THREE.MeshStandardMaterial({
    color: 0xbff4ff, emissive: 0x7fe7ff, emissiveIntensity: 1.5, roughness: 0.2, flatShading: true,
  }));
  orb.position.y = 5.4;
  g.add(orb);
  const orbLight = new THREE.PointLight(0x7fe7ff, 320, 30, 2);
  orbLight.position.y = 5.4;
  g.add(orbLight);
  g.userData = { orb, orbLight };

  g.position.set(75, heightAt(75, 70) - 1.1, 70);
  g.rotation.y = 0.9;
  return g;
})();
scene.add(ruins);

// --- hydrothermal vents at (-45, 105)
const vents = (() => {
  const g = new THREE.Group();
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x3a4148, roughness: 1, flatShading: true });
  const emberMat = new THREE.MeshStandardMaterial({
    color: 0xff8844, emissive: 0xff6622, emissiveIntensity: 1.2, roughness: 0.6, flatShading: true,
  });
  const tips = [];
  for (const [vx, vz, s] of [[0, 0, 1.4], [5, 3, 1.0], [-4, 4, 0.8]]) {
    const h = 4.5 * s;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(2.4 * s, h, 7), rockMat);
    cone.position.set(vx, h / 2, vz);
    g.add(cone);
    const throat = new THREE.Mesh(new THREE.CylinderGeometry(0.5 * s, 0.7 * s, 0.5, 6), emberMat);
    throat.position.set(vx, h - 0.1, vz);
    g.add(throat);
    tips.push(new THREE.Vector3(vx, h, vz));
  }
  const emberLight = new THREE.PointLight(0xff7733, 130, 20, 2);
  emberLight.position.set(0, 4, 1);
  g.add(emberLight);
  g.userData = { tips, emberLight };
  g.position.set(-45, heightAt(-45, 105) - 0.5, 105);
  return g;
})();
scene.add(vents);

// vent bubble columns — constant fast churn above the throats
const ventBubbles = (() => {
  const N = 130;
  const positions = new Float32Array(N * 3);
  const speed = new Float32Array(N);
  const tipIdx = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    tipIdx[i] = i % vents.userData.tips.length;
    const tip = vents.userData.tips[tipIdx[i]];
    positions[i * 3] = vents.position.x + tip.x + rand(-0.3, 0.3);
    positions[i * 3 + 1] = vents.position.y + tip.y + rand(0, 14);
    positions[i * 3 + 2] = vents.position.z + tip.z + rand(-0.3, 0.3);
    speed[i] = rand(3.5, 7);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    size: 0.5,
    map: radialTexture([[0, 'rgba(255,235,210,0.85)'], [1, 'rgba(255,235,210,0)']]),
    transparent: true, depthWrite: false, opacity: 0.6,
    blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.userData = { speed, tipIdx };
  return pts;
})();
scene.add(ventBubbles);

function animateVents(dt, t) {
  const pos = ventBubbles.geometry.attributes.position;
  const { speed, tipIdx } = ventBubbles.userData;
  for (let i = 0; i < pos.count; i++) {
    let y = pos.getY(i) + speed[i] * dt;
    pos.setX(i, pos.getX(i) + Math.sin(t * 2.4 + i * 1.3) * dt * 0.9);
    const tip = vents.userData.tips[tipIdx[i]];
    if (y > vents.position.y + tip.y + rand(11, 16)) {
      y = vents.position.y + tip.y;
      pos.setX(i, vents.position.x + tip.x + rand(-0.3, 0.3));
      pos.setZ(i, vents.position.z + tip.z + rand(-0.3, 0.3));
    }
    pos.setY(i, y);
  }
  pos.needsUpdate = true;
  vents.userData.emberLight.intensity = 110 + Math.sin(t * 7.3) * 25 + Math.sin(t * 13.7) * 15;
}

// --- crystal garden at (115, -85)
const crystals = (() => {
  const g = new THREE.Group();
  const mats = [
    new THREE.MeshStandardMaterial({ color: 0x2a7b96, emissive: 0x2fb8dd, emissiveIntensity: 0.5, roughness: 0.3, flatShading: true }),
    new THREE.MeshStandardMaterial({ color: 0x8c4a78, emissive: 0xd14da4, emissiveIntensity: 0.5, roughness: 0.3, flatShading: true }),
  ];
  for (let i = 0; i < 15; i++) {
    const c = new THREE.Mesh(new THREE.OctahedronGeometry(1, 0), mats[i % 2]);
    const s = rand(0.7, 2.4);
    c.scale.set(s * 0.45, s * rand(1.3, 2.0), s * 0.45);
    const a = rand(0, Math.PI * 2), r = rand(0, 7);
    c.position.set(Math.cos(a) * r, s * 0.7, Math.sin(a) * r);
    c.rotation.set(rand(-0.3, 0.3), rand(0, Math.PI), rand(-0.3, 0.3));
    g.add(c);
  }
  const glow = new THREE.PointLight(0x8fe4f7, 65, 20, 2);
  glow.position.y = 3;
  g.add(glow);
  g.userData = { mats, glow };
  g.position.set(115, heightAt(115, -85) - 0.3, -85);
  return g;
})();
scene.add(crystals);

// --- giant clam at (25, 30)
const clam = (() => {
  const g = new THREE.Group();
  const shellMat = new THREE.MeshStandardMaterial({ color: 0xc9b8d8, roughness: 0.6, flatShading: true });
  const shellGeo = new THREE.SphereGeometry(1.7, 9, 5, 0, Math.PI * 2, 0, Math.PI / 2);
  const bottom = new THREE.Mesh(shellGeo, shellMat);
  bottom.scale.y = 0.5;
  bottom.rotation.x = Math.PI;
  bottom.position.y = 0.85;
  g.add(bottom);
  const top = new THREE.Mesh(shellGeo, shellMat);
  top.scale.y = 0.55;
  top.position.y = 0.9;
  top.rotation.x = -0.62; // ajar
  g.add(top);
  const pearl = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), new THREE.MeshStandardMaterial({
    color: 0xfff6ec, emissive: 0xffeedd, emissiveIntensity: 1.1, roughness: 0.15, metalness: 0.1,
  }));
  pearl.position.set(0, 1.05, 0.35);
  g.add(pearl);
  const pearlLight = new THREE.PointLight(0xfff0dd, 50, 11, 2);
  pearlLight.position.set(0, 1.6, 0.4);
  g.add(pearlLight);
  g.position.set(25, heightAt(25, 30) - 0.15, 30);
  g.rotation.y = 2.2;
  g.scale.setScalar(1.4);
  return g;
})();
scene.add(clam);

// --- starfish & anemones scattered on the floor
const starfish = (() => {
  const arm = new THREE.ConeGeometry(0.2, 1.0, 4);
  arm.rotateX(Math.PI / 2);
  arm.translate(0, 0, 0.5);
  const parts = [];
  for (let k = 0; k < 5; k++) {
    const a = arm.clone();
    a.rotateY((k / 5) * Math.PI * 2);
    parts.push(a);
  }
  const hub = new THREE.SphereGeometry(0.28, 6, 4);
  hub.scale(1, 0.5, 1);
  parts.push(hub);
  const geo = BufferGeometryUtils.mergeGeometries(parts);
  const group = new THREE.Group();
  for (const color of [0xff7e54, 0x9d6bd6]) {
    const inst = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({
      color, roughness: 0.9, flatShading: true, emissive: color, emissiveIntensity: 0.12,
    }), 9);
    scatterOnFloor(inst, 9, { sMin: 0.8, sMax: 2.0, maxH: 4.5, sink: 0.02 });
    group.add(inst);
  }
  return group;
})();
scene.add(starfish);

const anemones = (() => {
  const parts = [];
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2;
    const lean = rand(0.25, 0.6);
    const tent = new THREE.CylinderGeometry(0.035, 0.09, rand(0.9, 1.4), 4);
    tent.translate(0, 0.55, 0);
    tent.rotateZ(lean * Math.cos(a));
    tent.rotateX(lean * Math.sin(a));
    parts.push(tent);
  }
  const base = new THREE.CylinderGeometry(0.32, 0.42, 0.35, 7);
  base.translate(0, 0.18, 0);
  parts.push(base);
  const geo = BufferGeometryUtils.mergeGeometries(parts);
  const inst = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({
    color: 0xff8fb3, roughness: 0.8, flatShading: true, emissive: 0xff5e8f, emissiveIntensity: 0.3,
  }), 18);
  scatterOnFloor(inst, 18, { sMin: 0.9, sMax: 2.2, maxH: 4.5, sink: 0.05 });
  return inst;
})();
scene.add(anemones);

// --- the whale: a slow giant on the far circuit
const whale = (() => {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x49616f, roughness: 0.85, flatShading: true, side: THREE.DoubleSide });
  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), mat);
  body.scale.set(2.1, 1.8, 5.4);
  g.add(body);
  const jaw = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshStandardMaterial({
    color: 0x9fb3bd, roughness: 0.9, flatShading: true,
  }));
  jaw.scale.set(1.6, 0.9, 2.6);
  jaw.position.set(0, -0.9, 2.8);
  g.add(jaw);

  const tail = new THREE.Group();
  const stem = new THREE.Mesh(new THREE.ConeGeometry(1.1, 4.2, 6), mat);
  stem.rotation.x = -Math.PI / 2;
  stem.position.z = -2.0;
  tail.add(stem);
  const flukeL = new THREE.Mesh(finTriangle([0, 0, -3.4], [-3.4, 0, -5.4], [-0.4, 0, -4.8]), mat);
  const flukeR = new THREE.Mesh(finTriangle([0, 0, -3.4], [3.4, 0, -5.4], [0.4, 0, -4.8]), mat);
  tail.add(flukeL, flukeR);
  tail.position.z = -3.2;
  g.add(tail);

  const finL = new THREE.Mesh(finTriangle([-1.6, -0.7, 1.4], [-3.6, -1.6, 0.3], [-1.7, -0.8, 0.2]), mat);
  const finR = new THREE.Mesh(finTriangle([1.6, -0.7, 1.4], [3.6, -1.6, 0.3], [1.7, -0.8, 0.2]), mat);
  g.add(finL, finR);

  g.scale.setScalar(2.2);
  g.userData = { tail };
  return g;
})();
scene.add(whale);

// --- island flora: palms on the beach, scrub on the meadow
function makePalm() {
  const g = new THREE.Group();
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 1, flatShading: true });
  const frondMat = new THREE.MeshStandardMaterial({
    color: 0x4d9e58, roughness: 0.85, flatShading: true, side: THREE.DoubleSide,
  });
  const lean = rand(0.06, 0.22), leanDir = rand(0, Math.PI * 2);
  let px = 0, py = 0;
  const segs = 4;
  for (let s = 0; s < segs; s++) {
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.16 - s * 0.02, 0.2 - s * 0.02, 1.9, 5), trunkMat);
    seg.position.set(px + Math.cos(leanDir) * lean * s, py + 0.9, Math.sin(leanDir) * lean * s);
    seg.rotation.z = lean * Math.cos(leanDir) * 1.2;
    seg.rotation.x = -lean * Math.sin(leanDir) * 1.2;
    g.add(seg);
    px += Math.cos(leanDir) * lean * 1.6;
    py += 1.72;
  }
  const crownY = py + 0.5, crownX = px + Math.cos(leanDir) * lean * 2;
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + rand(-0.2, 0.2);
    const frond = new THREE.Mesh(new THREE.ConeGeometry(0.55, 3.4, 3), frondMat);
    frond.scale.y = 1;
    frond.scale.z = 0.22;
    frond.position.set(crownX + Math.cos(a) * 1.45, crownY, Math.sin(a) * 1.45);
    frond.rotation.y = -a;
    frond.rotation.z = Math.PI / 2 - 0.55 - rand(0, 0.25); // droop
    g.add(frond);
  }
  return g;
}

const islandFlora = new THREE.Group();
{
  let palms = 0, guard = 0;
  while (palms < 12 && guard++ < 300) {
    const a = rand(0, Math.PI * 2), r = rand(6, 40);
    const x = ISLAND.x + Math.cos(a) * r, z = ISLAND.z + Math.sin(a) * r;
    const y = heightAt(x, z);
    if (y < SURFACE_Y + 1.5 || y > SURFACE_Y + 9) continue;
    const palm = makePalm();
    palm.position.set(x, y - 0.2, z);
    palm.rotation.y = rand(0, Math.PI * 2);
    palm.scale.setScalar(rand(0.85, 1.5));
    islandFlora.add(palm);
    palms++;
  }
  // scrub bushes higher up
  const bushMat = new THREE.MeshStandardMaterial({ color: 0x4f8f4a, roughness: 1, flatShading: true });
  let bushes = 0; guard = 0;
  while (bushes < 14 && guard++ < 300) {
    const a = rand(0, Math.PI * 2), r = rand(4, 34);
    const x = ISLAND.x + Math.cos(a) * r, z = ISLAND.z + Math.sin(a) * r;
    const y = heightAt(x, z);
    if (y < SURFACE_Y + 4 || y > SURFACE_Y + 16) continue;
    const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(rand(0.6, 1.4), 0), bushMat);
    bush.position.set(x, y + 0.2, z);
    bush.scale.y = 0.7;
    bush.rotation.y = rand(0, Math.PI);
    islandFlora.add(bush);
    bushes++;
  }
  // beach boulders at the waterline
  const beachRock = new THREE.MeshStandardMaterial({ color: 0x9aa4ad, roughness: 1, flatShading: true });
  let rocks2 = 0; guard = 0;
  while (rocks2 < 8 && guard++ < 300) {
    const a = rand(0, Math.PI * 2), r = rand(20, 52);
    const x = ISLAND.x + Math.cos(a) * r, z = ISLAND.z + Math.sin(a) * r;
    const y = heightAt(x, z);
    if (y < SURFACE_Y - 3 || y > SURFACE_Y + 3) continue;
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(rand(1, 2.6), 0), beachRock);
    rock.position.set(x, y, z);
    rock.rotation.set(rand(0, 1), rand(0, Math.PI), rand(0, 1));
    islandFlora.add(rock);
    rocks2++;
  }
}
scene.add(islandFlora);

function animateWhale(t) {
  const speed = 0.028, R = 130;
  const a = t * speed + 1.0;
  const y = 24 + Math.sin(t * 0.14) * 4;
  whale.position.set(Math.cos(a) * R, y, Math.sin(a) * R);
  whale.lookAt(Math.cos(a + 0.04) * R, y + Math.cos(t * 0.14) * 0.5, Math.sin(a + 0.04) * R);
  whale.rotateZ(-0.12);
  whale.userData.tail.rotation.x = Math.sin(t * 1.05) * 0.22;
}

// ---------------------------------------------------------------- submarine
// A small mustard research sub. The player drives it; the camera follows.

const sub = new THREE.Group();
const subParts = {};
{
  const hullMat = new THREE.MeshStandardMaterial({ color: 0xe8a33d, roughness: 0.45, metalness: 0.25, flatShading: true });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x3f4a56, roughness: 0.6, metalness: 0.35, flatShading: true });
  const glowMat = new THREE.MeshStandardMaterial({
    color: 0xfff3cf, emissive: 0xffd9a0, emissiveIntensity: 1.6, roughness: 0.3,
  });

  // hull: cylinder + nose + tail, along +Z
  const body = new THREE.CylinderGeometry(0.62, 0.62, 2.2, 8);
  body.rotateX(Math.PI / 2);
  const noseG = new THREE.SphereGeometry(0.62, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2);
  noseG.rotateX(Math.PI / 2); noseG.translate(0, 0, 1.1);
  const tailG = new THREE.ConeGeometry(0.62, 1.3, 8);
  tailG.rotateX(-Math.PI / 2); tailG.translate(0, 0, -1.75);
  const hull = new THREE.Mesh(BufferGeometryUtils.mergeGeometries([body, noseG, tailG]), hullMat);
  sub.add(hull);

  // sail / conning tower
  const sail = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 0.62, 6), hullMat);
  sail.scale.z = 1.6;
  sail.position.set(0, 0.78, 0.3);
  sub.add(sail);
  const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 4), darkMat);
  scope.position.set(0, 1.25, 0.25);
  sub.add(scope);

  // dive planes + tail fins
  const planeG = new THREE.BoxGeometry(2.1, 0.08, 0.55);
  const bow = new THREE.Mesh(planeG, darkMat);
  bow.position.set(0, 0, 0.9);
  sub.add(bow);
  const sternH = new THREE.Mesh(planeG, darkMat);
  sternH.position.set(0, 0, -1.7);
  sub.add(sternH);
  const sternV = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.5, 0.55), darkMat);
  sternV.position.set(0, 0, -1.7);
  sub.add(sternV);

  // portholes
  for (const [px, pz] of [[0.56, 0.55], [0.56, 0.0], [-0.56, 0.55], [-0.56, 0.0]]) {
    const port = new THREE.Mesh(new THREE.SphereGeometry(0.1, 6, 4), glowMat);
    port.position.set(px, 0.12, pz);
    sub.add(port);
  }
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 6, 4), glowMat);
  lamp.position.set(0, -0.1, 1.72);
  sub.add(lamp);

  // propeller
  const prop = new THREE.Group();
  const hubM = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.18, 6), darkMat);
  hubM.rotation.x = Math.PI / 2;
  prop.add(hubM);
  const bladeG = new THREE.BoxGeometry(0.1, 0.7, 0.04);
  for (let b = 0; b < 3; b++) {
    const blade = new THREE.Mesh(bladeG, darkMat);
    blade.rotation.z = (b / 3) * Math.PI * 2;
    blade.rotation.y = 0.5;
    blade.position.set(Math.sin((b / 3) * Math.PI * 2) * -0.3, Math.cos((b / 3) * Math.PI * 2) * 0.3, 0);
    prop.add(blade);
  }
  prop.position.set(0, 0, -2.5);
  sub.add(prop);
  subParts.prop = prop;

  // headlight: spot + visible beam (stronger when deep)
  const head = new THREE.SpotLight(0xfff2cc, 0, 85, 0.55, 0.55, 1.1);
  head.position.set(0, -0.1, 1.7);
  const headTarget = new THREE.Object3D();
  headTarget.position.set(0, -0.6, 18);
  sub.add(headTarget);
  head.target = headTarget;
  sub.add(head);
  subParts.head = head;

  const beamLen = 26;
  const beamGeo = new THREE.CylinderGeometry(0.18, 3.4, beamLen, 10, 1, true);
  beamGeo.rotateX(Math.PI / 2 + 0.033); // slight downward cant, matches target
  beamGeo.translate(0, -0.45, beamLen / 2 + 1.7);
  const beamMat = new THREE.ShaderMaterial({
    uniforms: { uIntensity: { value: 0 }, uColor: { value: new THREE.Color(0xfff0c2) } },
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    side: THREE.DoubleSide, fog: false,
    vertexShader: /* glsl */`
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uIntensity; uniform vec3 uColor;
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main() {
        float fade = pow(vUv.y, 1.7);
        float rim = pow(abs(dot(normalize(vN), normalize(vV))), 1.6);
        gl_FragColor = vec4(uColor, fade * (0.3 + 0.7 * rim) * uIntensity);
      }`,
  });
  const beam = new THREE.Mesh(beamGeo, beamMat);
  sub.add(beam);
  subParts.beam = beamMat;
}
sub.position.set(0, 16, 56);
sub.rotation.y = Math.PI; // face the reef
scene.add(sub);

// propeller wake: shader points with per-particle size, growth and fade.
// Bubbles inherit backward velocity from the prop, swirl, and buoy upward.
const WAKE_N = 240;
const wake = (() => {
  const positions = new Float32Array(WAKE_N * 3).fill(-999);
  const aLife = new Float32Array(WAKE_N);
  const aSeed = new Float32Array(WAKE_N);
  for (let i = 0; i < WAKE_N; i++) aSeed[i] = rng();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aLife', new THREE.BufferAttribute(aLife, 1));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      attribute float aLife; attribute float aSeed;
      varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float grow = 1.0 + (1.0 - aLife) * 2.2;          // bubbles expand as they age
        float size = (0.16 + aSeed * 0.22) * grow;
        gl_PointSize = size * (340.0 / max(0.1, -mv.z));
        vA = smoothstep(0.0, 0.12, aLife) * pow(aLife, 0.55);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float disc = smoothstep(0.5, 0.18, d);
        float ring = smoothstep(0.32, 0.42, d) * 0.5 + 0.5; // brighter shell rim
        gl_FragColor = vec4(vec3(0.82, 0.95, 1.0), disc * ring * vA * 0.8);
      }`,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.userData = {
    vel: new Float32Array(WAKE_N * 3),
    decay: new Float32Array(WAKE_N),
    next: 0,
    acc: 0,
  };
  return pts;
})();
scene.add(wake);

const wakeSpawn = new THREE.Vector3();
function emitWake(count, swirl) {
  const w = wake.userData;
  const posArr = wake.geometry.attributes.position.array;
  const lifeArr = wake.geometry.attributes.aLife.array;
  for (let n = 0; n < count; n++) {
    const k = w.next = (w.next + 1) % WAKE_N;
    posArr[k * 3] = wakeSpawn.x + rand(-0.22, 0.22);
    posArr[k * 3 + 1] = wakeSpawn.y + rand(-0.22, 0.22);
    posArr[k * 3 + 2] = wakeSpawn.z + rand(-0.22, 0.22);
    // thrown backward off the prop with a tangential swirl
    w.vel[k * 3] = -sFwd.x * swirl + rand(-0.8, 0.8);
    w.vel[k * 3 + 1] = rand(-0.5, 0.4);
    w.vel[k * 3 + 2] = -sFwd.z * swirl + rand(-0.8, 0.8);
    w.decay[k] = 1 / rand(1.1, 2.2);
    lifeArr[k] = 1;
  }
}

// surface splash: white spray thrown on breach/re-entry, with foam rings
const SPRAY_N = 220;
const spray = (() => {
  const positions = new Float32Array(SPRAY_N * 3).fill(-999);
  const aLife = new Float32Array(SPRAY_N);
  const aSeed = new Float32Array(SPRAY_N);
  for (let i = 0; i < SPRAY_N; i++) aSeed[i] = rng();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aLife', new THREE.BufferAttribute(aLife, 1));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.NormalBlending,
    vertexShader: /* glsl */`
      attribute float aLife; attribute float aSeed;
      varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float size = 0.36 + aSeed * 0.55;
        gl_PointSize = size * (340.0 / max(0.1, -mv.z));
        vA = pow(aLife, 0.8);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        gl_FragColor = vec4(vec3(0.94, 0.99, 1.0), smoothstep(0.5, 0.2, d) * vA * 0.9);
      }`,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.userData = { vel: new Float32Array(SPRAY_N * 3), next: 0 };
  return pts;
})();
scene.add(spray);

function emitSplash(x, z, power) {
  const s = spray.userData;
  const posArr = spray.geometry.attributes.position.array;
  const lifeArr = spray.geometry.attributes.aLife.array;
  const count = Math.min(90, Math.floor(20 + power * 6));
  for (let n = 0; n < count; n++) {
    const k = s.next = (s.next + 1) % SPRAY_N;
    const a = rand(0, Math.PI * 2), r = rand(0.2, 1.6);
    posArr[k * 3] = x + Math.cos(a) * r;
    posArr[k * 3 + 1] = SURFACE_Y + rand(0, 0.6);
    posArr[k * 3 + 2] = z + Math.sin(a) * r;
    const out = rand(1.5, 3.5) + power * 0.25;
    s.vel[k * 3] = Math.cos(a) * out;
    s.vel[k * 3 + 1] = rand(3, 6.5) + power * 0.5;
    s.vel[k * 3 + 2] = Math.sin(a) * out;
    lifeArr[k] = 1;
  }
}

function updateSpray(dt) {
  const s = spray.userData;
  const posArr = spray.geometry.attributes.position.array;
  const lifeArr = spray.geometry.attributes.aLife.array;
  for (let i = 0; i < SPRAY_N; i++) {
    if (lifeArr[i] <= 0) continue;
    lifeArr[i] -= dt * 1.1;
    s.vel[i * 3 + 1] -= dt * 17; // gravity
    posArr[i * 3] += s.vel[i * 3] * dt;
    posArr[i * 3 + 1] += s.vel[i * 3 + 1] * dt;
    posArr[i * 3 + 2] += s.vel[i * 3 + 2] * dt;
    if (lifeArr[i] <= 0 || posArr[i * 3 + 1] < SURFACE_Y - 1.5) {
      lifeArr[i] = 0;
      posArr[i * 3 + 1] = -999;
    }
  }
  spray.geometry.attributes.position.needsUpdate = true;
  spray.geometry.attributes.aLife.needsUpdate = true;
}

// expanding foam rings on the surface
const foamRings = [];
{
  const ringTex = (() => {
    const cnv = document.createElement('canvas');
    cnv.width = cnv.height = 128;
    const ctx = cnv.getContext('2d');
    ctx.strokeStyle = 'rgba(235, 250, 255, 0.9)';
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(64, 64, 52, 0, Math.PI * 2);
    ctx.stroke();
    return new THREE.CanvasTexture(cnv);
  })();
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, opacity: 0, depthWrite: false })
    );
    m.rotation.x = -Math.PI / 2;
    m.position.y = -999;
    scene.add(m);
    foamRings.push({ mesh: m, age: 99 });
  }
}
let foamNext = 0;
function spawnFoamRing(x, z) {
  const r = foamRings[foamNext = (foamNext + 1) % foamRings.length];
  r.age = 0;
  r.mesh.position.set(x, SURFACE_Y + 0.4, z);
}
function updateFoamRings(dt) {
  for (const r of foamRings) {
    if (r.age > 1.2) continue;
    r.age += dt;
    const s = 3 + r.age * 14;
    r.mesh.scale.set(s, s, 1);
    r.mesh.material.opacity = Math.max(0, 0.7 * (1 - r.age / 1.2));
    if (r.age > 1.2) r.mesh.position.y = -999;
  }
}

function updateWake(dt) {
  const w = wake.userData;
  const posArr = wake.geometry.attributes.position.array;
  const lifeArr = wake.geometry.attributes.aLife.array;
  const drag = Math.exp(-dt * 1.4);
  for (let i = 0; i < WAKE_N; i++) {
    if (lifeArr[i] <= 0) continue;
    lifeArr[i] -= dt * w.decay[i];
    w.vel[i * 3] *= drag;
    w.vel[i * 3 + 1] = Math.min(w.vel[i * 3 + 1] + dt * 2.4, 2.6); // buoyancy
    w.vel[i * 3 + 2] *= drag;
    posArr[i * 3] += w.vel[i * 3] * dt;
    posArr[i * 3 + 1] += w.vel[i * 3 + 1] * dt;
    posArr[i * 3 + 2] += w.vel[i * 3 + 2] * dt;
    if (lifeArr[i] <= 0 || posArr[i * 3 + 1] > SURFACE_Y - 0.5) {
      lifeArr[i] = 0;
      posArr[i * 3 + 1] = -999;
    }
  }
  wake.geometry.attributes.position.needsUpdate = true;
  wake.geometry.attributes.aLife.needsUpdate = true;
}

// ----------------------------------------------------------------- controls
// Trackpad-first: A/D steer, W/S throttle, drag orbits the camera, scroll
// (two-finger swipe) zooms. No pointer lock anywhere.

const keys = {};
let started = false;
const hud = document.getElementById('hud');

addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (!started && ['KeyW', 'KeyS', 'ArrowUp', 'ArrowDown'].includes(e.code)) {
    started = true;
    hud.classList.add('diving');
    startAudio();
  }
});
addEventListener('keyup', (e) => { keys[e.code] = false; });

const orbit = { yaw: 0, pitch: 0, dragging: false, lastX: 0, lastY: 0 };
let camDist = 11;

renderer.domElement.addEventListener('pointerdown', (e) => {
  orbit.dragging = true;
  orbit.lastX = e.clientX; orbit.lastY = e.clientY;
  startAudio();
});
addEventListener('pointermove', (e) => {
  if (!orbit.dragging) return;
  orbit.yaw -= (e.clientX - orbit.lastX) * 0.0065;
  orbit.pitch += (e.clientY - orbit.lastY) * 0.005;
  orbit.pitch = THREE.MathUtils.clamp(orbit.pitch, -0.5, 0.9);
  orbit.lastX = e.clientX; orbit.lastY = e.clientY;
});
addEventListener('pointerup', () => { orbit.dragging = false; });
addEventListener('pointercancel', () => { orbit.dragging = false; });
addEventListener('wheel', (e) => {
  camDist = THREE.MathUtils.clamp(camDist + e.deltaY * 0.02, 6, 24);
}, { passive: true });

// ------------------------------------------------------------ sub dynamics

const subState = {
  yaw: Math.PI,
  vel: new THREE.Vector3(),
  yawVel: 0,
  speed: 0,           // smoothed forward speed for FX
  pitchVis: 0,
  rollVis: 0,
};
const sFwd = new THREE.Vector3();
const thrustDir = new THREE.Vector3();
const camTarget = new THREE.Vector3().copy(sub.position);
const camDesired = new THREE.Vector3();
const lookTarget = new THREE.Vector3().copy(sub.position);

function updateSub(dt, t) {
  const st = subState;
  const boost = (keys.ShiftLeft || keys.ShiftRight) ? 2.1 : 1;
  const airborne = sub.position.y > SURFACE_Y + 0.3;

  // steering (rudder barely bites in the air)
  let steer = 0;
  if (keys.KeyA || keys.ArrowLeft) steer += 1;
  if (keys.KeyD || keys.ArrowRight) steer -= 1;
  st.yawVel += steer * dt * 2.6 * (airborne ? 0.3 : 1);
  st.yawVel *= Math.exp(-dt * 3.2);
  st.yaw += st.yawVel * dt * 60 * 0.016;

  sFwd.set(Math.sin(st.yaw), 0, Math.cos(st.yaw));

  // thrust follows the nose: pitch up while throttling and the sub climbs —
  // hold SPACE+W+SHIFT to leap clear of the water (the prop has nothing to
  // push against in the air)
  let thrust = 0;
  if (keys.KeyW || keys.ArrowUp) thrust += 1;
  if (keys.KeyS || keys.ArrowDown) thrust -= 0.55;
  const nose = -st.pitchVis;
  thrustDir.set(sFwd.x * Math.cos(nose), Math.sin(nose), sFwd.z * Math.cos(nose));
  st.vel.addScaledVector(thrustDir, thrust * 17 * boost * (airborne ? 0.1 : 1) * dt);

  // ballast underwater; ballistic above
  let lift = 0;
  if (keys.Space) lift += 1;
  if (keys.KeyC || keys.ControlLeft) lift -= 1;
  if (airborne) {
    st.vel.y -= 20 * dt; // gravity
  } else {
    st.vel.y += lift * 13 * dt;
  }

  st.vel.multiplyScalar(Math.exp(-dt * (airborne ? 0.25 : 1.6)));
  const prevY = sub.position.y;
  sub.position.addScaledVector(st.vel, dt);

  // gentle idle bob
  if (!airborne) sub.position.y += Math.sin(t * 0.7) * dt * 0.12;

  // breach / re-entry splash
  st.splashCool = Math.max(0, (st.splashCool || 0) - dt);
  const wasUnder = prevY < SURFACE_Y, isUnder = sub.position.y < SURFACE_Y;
  if (wasUnder !== isUnder && st.splashCool <= 0) {
    const power = Math.abs(st.vel.y) + st.speed * 0.3;
    emitSplash(sub.position.x, sub.position.z, power);
    spawnFoamRing(sub.position.x, sub.position.z);
    st.splashCool = 0.45;
  }

  // bounds
  const horiz = Math.hypot(sub.position.x, sub.position.z);
  if (horiz > WORLD_R) {
    const k = WORLD_R / horiz;
    sub.position.x *= k; sub.position.z *= k;
    st.vel.multiplyScalar(0.6);
  }
  // shallows slide the hull away instead of letting it climb the beach
  const floorH = heightAt(sub.position.x, sub.position.z);
  if (floorH > SURFACE_Y - 6) {
    const gx = heightAt(sub.position.x + 1.5, sub.position.z) - heightAt(sub.position.x - 1.5, sub.position.z);
    const gz = heightAt(sub.position.x, sub.position.z + 1.5) - heightAt(sub.position.x, sub.position.z - 1.5);
    st.vel.x -= gx * 14 * dt;
    st.vel.z -= gz * 14 * dt;
  }
  const floor = floorH + 2.0;
  sub.position.y = Math.max(sub.position.y, floor);
  sub.position.y = Math.min(sub.position.y, SURFACE_Y + 40);

  // visual attitude: pitch with vertical motion, bank into turns
  const fwdSpeed = st.vel.dot(sFwd);
  st.speed += (Math.abs(fwdSpeed) - st.speed) * Math.min(1, dt * 4);
  st.pitchVis += (THREE.MathUtils.clamp(-st.vel.y * 0.055, -0.5, 0.5) - st.pitchVis) * Math.min(1, dt * 3);
  st.rollVis += (THREE.MathUtils.clamp(-st.yawVel * 0.5, -0.4, 0.4) - st.rollVis) * Math.min(1, dt * 3);
  sub.rotation.set(st.pitchVis, st.yaw, st.rollVis, 'YXZ');

  // propeller
  subParts.prop.rotation.z += dt * (3 + fwdSpeed * 2.2 + (thrust !== 0 ? 6 : 0));

  // wake emission scales with throttle; faint drips when idling
  wakeSpawn.copy(sub.position).addScaledVector(sFwd, -2.6);
  const w = wake.userData;
  const rate = thrust !== 0
    ? (38 + Math.abs(fwdSpeed) * 4) * (boost > 1 ? 1.6 : 1)
    : (Math.abs(fwdSpeed) > 3 ? 14 : 1.2);
  w.acc += rate * dt;
  if (w.acc >= 1) {
    const n = Math.floor(w.acc);
    w.acc -= n;
    emitWake(n, 1.4 + Math.abs(fwdSpeed) * 0.35);
  }
  updateWake(dt);
}

// ------------------------------------------------------------- chase camera

function updateCamera(dt) {
  const st = subState;

  // orbit angles ease back behind the sub when not dragging
  if (!orbit.dragging) {
    orbit.yaw *= Math.exp(-dt * 1.6);
    orbit.pitch *= Math.exp(-dt * 1.1);
  }

  const a = st.yaw + Math.PI + orbit.yaw; // behind the sub
  const el = 0.32 + orbit.pitch;
  const ch = Math.cos(el), sh = Math.sin(el);
  camDesired.set(
    sub.position.x + Math.sin(a) * ch * camDist,
    sub.position.y + sh * camDist,
    sub.position.z + Math.cos(a) * ch * camDist
  );
  // keep the camera out of the floor; it follows the sub above the surface
  camDesired.y = Math.max(camDesired.y, heightAt(camDesired.x, camDesired.z) + 1.2);

  const ease = 1 - Math.exp(-dt * 4.2);
  camera.position.lerp(camDesired, ease);

  lookTarget.set(
    sub.position.x + sFwd.x * 3.5,
    sub.position.y + 0.8,
    sub.position.z + sFwd.z * 3.5
  );
  camTarget.lerp(lookTarget, 1 - Math.exp(-dt * 5));
  camera.lookAt(camTarget);

  // speed widens the lens slightly — cheap cinematic dolly feel
  const targetFov = 62 + Math.min(st.speed, 26) * 0.45;
  camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 3);
  camera.updateProjectionMatrix();

  sky.position.copy(camera.position);
}

// --------------------------------------------------------------- particles

const bubbles = (() => {
  const N = 240;
  const positions = new Float32Array(N * 3);
  const speeds = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = rand(0, Math.PI * 2), r = rand(0, 170);
    positions[i * 3] = Math.cos(a) * r;
    positions[i * 3 + 1] = rand(0, SURFACE_Y);
    positions[i * 3 + 2] = Math.sin(a) * r;
    speeds[i] = rand(1.2, 3.2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    size: 0.42,
    map: radialTexture([[0, 'rgba(225,248,255,0.9)'], [1, 'rgba(225,248,255,0)']]),
    transparent: true, depthWrite: false, opacity: 0.7,
    blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.userData.speeds = speeds;
  return pts;
})();
scene.add(bubbles);

function animateBubbles(dt, t) {
  const pos = bubbles.geometry.attributes.position;
  const speeds = bubbles.userData.speeds;
  for (let i = 0; i < pos.count; i++) {
    let y = pos.getY(i) + speeds[i] * dt;
    pos.setX(i, pos.getX(i) + Math.sin(t * 1.8 + i) * dt * 0.5);
    if (y > SURFACE_Y - 0.5) {
      y = heightAt(pos.getX(i), pos.getZ(i)) + 0.5;
    }
    pos.setY(i, y);
  }
  pos.needsUpdate = true;
}

const motes = (() => {
  const N = 700, BOX = 90;
  const positions = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    positions[i * 3] = rand(-BOX / 2, BOX / 2);
    positions[i * 3 + 1] = rand(2, SURFACE_Y - 2);
    positions[i * 3 + 2] = rand(-BOX / 2, BOX / 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    size: 0.14,
    map: radialTexture([[0, 'rgba(190,230,235,0.8)'], [1, 'rgba(190,230,235,0)']]),
    transparent: true, depthWrite: false, opacity: 0.45,
    blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.userData.box = BOX;
  return pts;
})();
scene.add(motes);

function animateMotes(dt, t) {
  const pos = motes.geometry.attributes.position;
  const BOX = motes.userData.box, half = BOX / 2;
  const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i) + Math.sin(t * 0.4 + i * 1.7) * dt * 0.45;
    let y = pos.getY(i) + Math.cos(t * 0.3 + i * 0.9) * dt * 0.3 + dt * 0.12;
    let z = pos.getZ(i) + Math.cos(t * 0.35 + i * 2.3) * dt * 0.45;
    if (x - cx > half) x -= BOX; else if (x - cx < -half) x += BOX;
    if (z - cz > half) z -= BOX; else if (z - cz < -half) z += BOX;
    if (y > SURFACE_Y - 1) y = Math.max(2, cy - half * 0.5);
    if (y - cy > half) y -= BOX * 0.7; else if (y - cy < -half) y += BOX * 0.7;
    pos.setX(i, x); pos.setY(i, y); pos.setZ(i, z);
  }
  pos.needsUpdate = true;
}

// ---------------------------------------------------------- post processing

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.42, 0.55, 0.85);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------------------------------------------------------- depth ambience

const fogShallow = new THREE.Color(0x1a6f9e);
const fogDeep = new THREE.Color(0x05283c);
const skyTopShallow = new THREE.Color(0x46b3d4);
const skyTopDeep = new THREE.Color(0x0d4d6b);
const skyBotShallow = new THREE.Color(0x0a3d5c);
const skyBotDeep = new THREE.Color(0x031824);
// above the surface: warm tropical air
const fogAir = new THREE.Color(0xc9e4f0);
const skyTopAir = new THREE.Color(0x3e9ad2);
const skyBotAir = new THREE.Color(0xdcedf2);
const sunUnder = new THREE.Color(0xc8ecdf);
const sunAir = new THREE.Color(0xfff0cd);
const hemiUnder = new THREE.Color(0x5aa8cf);
const hemiAir = new THREE.Color(0xcfe6f2);
const hemiGroundUnder = new THREE.Color(0x0a2e40);
const hemiGroundAir = new THREE.Color(0x6f7d5e);

function updateAmbience() {
  const d = THREE.MathUtils.clamp(1 - camera.position.y / SURFACE_Y, 0, 1);
  // 0 fully underwater -> 1 in the air; crossfades over ~2.5m around the surface
  const air = THREE.MathUtils.smoothstep(camera.position.y, SURFACE_Y - 1.8, SURFACE_Y + 0.7);

  scene.fog.color.lerpColors(fogShallow, fogDeep, d * 0.9).lerp(fogAir, air);
  scene.fog.density = THREE.MathUtils.lerp(0.0125 + d * 0.0065, 0.0011, air);
  skyUniforms.cTop.value.lerpColors(skyTopShallow, skyTopDeep, d * 0.85).lerp(skyTopAir, air);
  skyUniforms.cBottom.value.lerpColors(skyBotShallow, skyBotDeep, d * 0.85).lerp(skyBotAir, air);
  sun.intensity = THREE.MathUtils.lerp(1.55 - d * 0.8, 1.95, air);
  sun.color.lerpColors(sunUnder, sunAir, air);
  hemi.intensity = THREE.MathUtils.lerp(0.6 - d * 0.25, 0.95, air);
  hemi.color.lerpColors(hemiUnder, hemiAir, air);
  hemi.groundColor.lerpColors(hemiGroundUnder, hemiGroundAir, air);
  bounce.intensity = 1.0 * (1 - air);
  causticStrength.value = 0.45 - d * 0.2;

  // underwater sun glow gives way to the real sun overhead
  sunGlow.material.opacity = (0.95 - d * 0.55) * (1 - air);
  sunHalo.material.opacity = (0.5 - d * 0.3) * (1 - air);
  skySun.material.opacity = 0.22 + air * 0.78;

  // headlight fades in with depth
  const dive = THREE.MathUtils.smoothstep(d, 0.3, 0.85);
  subParts.head.intensity = dive * 1300;
  subParts.beam.uniforms.uIntensity.value = dive * 0.22;
}

// ----------------------------------------------------------------- ambience
// Procedural underwater pad. Starts on first interaction, M toggles mute.

let audio = null;
function startAudio() {
  if (audio) return;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const master = ctx.createGain();
  master.gain.value = 0;
  master.gain.linearRampToValueAtTime(1, ctx.currentTime + 4);
  master.connect(ctx.destination);

  const len = ctx.sampleRate * 4;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    data[i] = last * 3.5;
  }
  const noise = ctx.createBufferSource();
  noise.buffer = buf; noise.loop = true;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 240; lp.Q.value = 0.4;
  const nGain = ctx.createGain(); nGain.gain.value = 0.05;
  noise.connect(lp).connect(nGain).connect(master);
  noise.start();

  const lfo = ctx.createOscillator(); lfo.frequency.value = 0.06;
  const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.02;
  lfo.connect(lfoGain).connect(nGain.gain);
  lfo.start();

  for (const [freq, vol] of [[55, 0.016], [55.4, 0.014], [82.5, 0.007]]) {
    const osc = ctx.createOscillator();
    osc.type = 'sine'; osc.frequency.value = freq;
    const g = ctx.createGain(); g.gain.value = vol;
    osc.connect(g).connect(master);
    osc.start();
  }
  audio = { ctx, master, muted: false };
}
addEventListener('keydown', (e) => {
  if (e.code === 'KeyM' && audio) {
    audio.muted = !audio.muted;
    audio.master.gain.setTargetAtTime(audio.muted ? 0 : 1, audio.ctx.currentTime, 0.3);
  }
});

// --------------------------------------------------------------------- HUD

const depthEl = document.getElementById('depthVal');
const hdgEl = document.getElementById('hdgVal');
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
let hudTimer = 0;

function updateHUD(dt) {
  hudTimer -= dt;
  if (hudTimer > 0) return;
  hudTimer = 0.12;
  const depth = Math.max(0, SURFACE_Y - sub.position.y);
  depthEl.textContent = depth.toFixed(1);
  let deg = ((180 - subState.yaw * 180 / Math.PI) % 360 + 360) % 360;
  const dir = COMPASS[Math.round(deg / 45) % 8];
  hdgEl.textContent = `${dir} ${String(Math.round(deg)).padStart(3, '0')}°`;
}

// -------------------------------------------------------------------- loop

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

window.__dbg = { scene, water, camera, sub, subState };

// debug vantage points: ?x=0&y=10&z=0&yaw=1.2 (sub placement + heading)
{
  const qs = new URLSearchParams(location.search);
  if (qs.has('x')) sub.position.set(+qs.get('x'), +qs.get('y'), +qs.get('z'));
  if (qs.has('yaw')) subState.yaw = +qs.get('yaw');
  if (qs.has('oyaw')) orbit.yaw = +qs.get('oyaw');
  if (qs.has('opitch')) orbit.pitch = +qs.get('opitch');
  if (qs.has('dist')) camDist = +qs.get('dist');
  camera.position.set(sub.position.x, sub.position.y + 4, sub.position.z + 11);
}

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  uTime.value = t;

  updateSub(dt, t);
  updateCamera(dt);
  updateAmbience();
  updateHUD(dt);

  animateWater(t);
  animateFish(t);
  animateMantas(t);
  animateTurtles(t);
  animateJellies(dt, t);
  animateBubbles(dt, t);
  animateMotes(dt, t);
  animateVents(dt, t);
  animateWhale(t);
  updateSpray(dt);
  updateFoamRings(dt);

  // clouds drift on the trade wind
  for (const cl of clouds.children) {
    cl.position.x += cl.userData.speed * dt;
    if (cl.position.x > 330) cl.position.x = -330;
  }

  // ruins relic bobs; crystal garden breathes
  ruins.userData.orb.position.y = 5.4 + Math.sin(t * 0.9) * 0.5;
  ruins.userData.orb.rotation.y = t * 0.4;
  ruins.userData.orbLight.position.y = ruins.userData.orb.position.y;
  ruins.userData.orbLight.intensity = 300 + Math.sin(t * 1.7) * 60;
  crystals.userData.mats[0].emissiveIntensity = 0.45 + Math.sin(t * 1.3) * 0.15;
  crystals.userData.mats[1].emissiveIntensity = 0.45 + Math.sin(t * 1.3 + 2.1) * 0.15;

  for (const g of shafts.children) {
    g.rotation.z = -0.14 + Math.sin(t * 0.16 * g.userData.sway + g.userData.phase) * 0.04;
  }

  composer.render();
});
