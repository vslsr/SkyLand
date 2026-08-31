# DRIFT — a poly ocean

A low-poly 3D ocean exploration experience built with three.js. You pilot a
small mustard research submarine in third person through a flat-shaded poly
reef: layered light shafts, procedural caustics, a faceted water ceiling,
schooling fish with swimming tails, mantas, turtles, glowing jellyfish, a
cruising whale, and a headlight that fades in as the deep gets dark.

Worth steering toward: a shipwreck with a glowing treasure chest (NW), sunken
ruins with a bobbing relic orb (SE), hydrothermal vents (S), a crystal garden
in the deep (E), a giant clam with a pearl near the spawn reef — and a big
palm island in the southwest that rises out of the water. Two fish schools
swirl tight around the wreck and the ruins.

The surface is real: pitch up under full throttle (SPACE + W + SHIFT) and the
sub leaps clear of the water with spray and foam rings, arcs through the air
under gravity, and splashes back down. Above the waterline the world
crossfades to tropical air — thin fog, a warm sun disc, drifting low-poly
clouds — and back to blue depth grading as you dive.

## Run

```sh
python3 -m http.server 8123
# open http://localhost:8123
```

(any static file server works — three.js loads from the jsDelivr CDN)

## Controls (trackpad-friendly — no pointer lock)

| input | action |
|---|---|
| W / S | throttle forward / reverse |
| A / D | steer |
| Space / C | ballast up / down |
| Shift | boost |
| drag | orbit the camera (eases back behind the sub) |
| scroll / two-finger swipe | camera zoom |
| M | toggle ambient sound |

## Notable techniques

- **Caustics** — iterative water-caustic function injected into the terrain
  material via `onBeforeCompile`, added *before* the fog pass so distance
  attenuates it correctly.
- **Light shafts** — crossed translucent blades with soft horizontal edges,
  vertical fade, and two drifting streak frequencies; reads volumetric from
  any angle (cylinder cones read as "circles" — these don't).
- **Faceted water ceiling** — per-face vertex tints on a non-indexed plane;
  wave terms are separable in x/z, so each frame fills a 97×97 grid from
  per-axis trig tables instead of 55k trig calls.
- **Fish** — two-cone bodies with forked tails, dorsal and pectoral fins;
  fins darkened via vertex colors, per-instance hue via `instanceColor`,
  tails swim via a vertex-shader bend keyed on instance position.
- **Chase camera** — spring-follow with orbit offsets that ease back behind
  the sub, scroll zoom, and speed-widened FOV.
- **Depth grading** — fog, sun, sky gradient, caustic strength, and the
  sub's headlight all lerp with depth.

## Dev scripts

- `node scripts/shot.mjs out.png 6000 "x=0&y=20&z=0&yaw=1&oyaw=0.5&dist=9"` —
  headless screenshot (params place the sub and orbit camera)
- `node scripts/drive.mjs` — drives the sub (W + A) and verifies movement
- `node scripts/fps.mjs` — headless FPS probe (software GL; real GPUs are much faster)
