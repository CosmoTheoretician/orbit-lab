# Orbit Lab

**A browser-based orbital environment and flight dynamics sandbox: the live satellite catalog, a validated SGP4 pipeline, and a simulated model of SES's next-generation meoSphere MEO constellation, propagated with a self-written J2 model built on geometric algebra.**

> **Live demo:** _link coming soon_ · **Video:** _link coming soon_

![screenshot](docs/screenshot.png)

Independent student project. Not affiliated with or endorsed by SES, SpaceX, Eutelsat, Amazon, or K2 Space. meoSphere parameters not published by SES (inclination, phasing) are explicitly marked as assumptions.

---

## What it does

- **Live orbital environment.** About 16,000 active objects from public CelesTrak data, propagated in real time with SGP4 in a Web Worker and rendered with Three.js. Operators are color-coded: SES (including the former Intelsat fleet and all 30 O3b / O3b mPOWER satellites), SpaceX Starlink, Eutelsat OneWeb, Amazon Leo, and everything else active.
- **Simulated meoSphere phase 1.** A configurable Walker Delta constellation (28 satellites, 4 planes, ~8,000 km) propagated with an own mean-element J2 model and drawn next to the real O3b fleet. It shows directly how meoSphere's inclined planes differ from O3b's equatorial orbit.
- **Physically consistent scene.** Earth rotates by Greenwich sidereal time, the Sun direction is computed from a low-precision ephemeris (so the day/night terminator is real), and every layer is drawn at the same epoch.
- **Time control.** Real time, pause, and warp from 1/64× to 65,536×. At high warp you can watch J2 nodal regression slowly turn the meoSphere orbital planes westward.

## Validation

Validation is the core of this project: every model is checked against an independent reference, and every discrepancy is either explained or openly reported.

### SGP4 against the official reference set

The SGP4 pipeline is tested against the verification set from Vallado et al., *"Revisiting Spacetrack Report #3"* (AIAA 2006-6753): 33 test cases covering near-Earth, deep-space, resonant, and deliberately pathological orbits.

| Result | Cases |
|---|---|
| Match to the reference's print precision | 31 |
| Correctly rejected (reference expects an error) | 1 (33334) |
| Explained discrepancy, under investigation | 1 (23599) |

**The tolerance comes from the data, not from a chosen threshold.** The reference prints positions to 10⁻⁸ km and velocities to 10⁻⁹ km/s. Rounding each component by at most half a unit bounds the vector error by √3/2 of a unit: 0.0087 mm in position and 0.87 µm/s in velocity. All 31 passing cases fall within these bounds (worst: 0.0081 mm, 0.853 µm/s), meaning agreement is exact to the precision the reference was printed.

**Case 23599: a discrepancy traced to a node crossing.** This low-inclination (6.93°), highly eccentric (e = 0.578) deep-space orbit shows a position difference of up to 0.96 km. Two observations identify the cause:

1. The error divided by orbital radius is constant (≈ 3.95 × 10⁻⁵), so the two results differ by a small rigid rotation, not by random numerical error.
2. Agreement is perfect until t ≈ 410 min, then the offset appears abruptly.

J2 nodal regression, dΩ/dt = −(3/2) n J2 (R⊕/p)² cos i, gives about −6.8 × 10⁻⁴ °/min for this orbit. Starting from Ω₀ = 0.2849°, the ascending node reaches 0° after **≈ 417 minutes**, exactly where the discrepancy begins. This is consistent with the documented difference in how SGP4's operating modes handle the node angle in the low-inclination deep-space branch. Confirmation is planned once the own SGP4 implementation can run both modes.

**A formatting artifact in the reference output.** In the long-duration case for satellite 20413 (propagated 3.5 years past epoch, to a perigee physically inside the Earth), one line of the official reference file contains 24 concatenated states. Their ~12-hour period shows they belong to a different object (20413 takes about 4 days per orbit). The test harness detects such lines, skips them, and reports the count rather than silently dropping data. With that handled, the case matches exactly.

### Geometric algebra and J2 model

- **Rotors against rotation matrices:** the rotor composition R_Ω R_i R_ω matches the classical 3-1-3 rotation Rz(Ω) Rx(i) Rz(ω) to 10⁻⁹ km at 10⁴ km scale across 1,000 random orientations, and composed rotors stay normalized (R R̃ = 1).
- **Two-body limit:** with J2 = 0, orbits close after one period to below 1 mm, and |r∧v| equals √(μp) to 12 significant digits.
- **Secular J2 drift:** the orbital plane, read directly from the bivector r∧v, regresses at exactly the analytical J2 rate (to 10⁻¹² rad over 30 days), with inclination constant.

## Technical highlights

**Geometric algebra for orbit geometry.** The orbital plane is represented as the bivector L = r∧v, which carries both the plane's orientation and the angular momentum magnitude. Orbit orientation is a rotor composed of rotations named by the planes they act in (e₁∧e₂ for the equator), applied by the sandwich product v' = R v R̃. In 3D, rotors are isomorphic to unit quaternions, so there's no performance cost; the GA form maps directly onto how orbital angles are defined.

**Rigorous time handling.** An `Epoch` stores TT seconds since J2000.0 (sub-microsecond resolution), with conversions from UTC through the full leap-second table (TAI − UTC) and to TDB for planetary ephemerides.

**Explicit frames.** Every state vector carries its origin body and axes (`TEME`, `ICRF`, `ITRF`, `MOON_PA`, `IAU_MARS`) to prevent silent frame mixing, the classic multi-body bug. This prepares the code for lunar and Mars extensions.

**Physics in kilometers, rendering scaled separately.** All physics runs in km and float64; only a single scene group scales to render units. This keeps the door open for floating-origin rendering at interplanetary distances, where float32 positions would jitter by kilometers.

**Performance baseline.** SGP4 for 15,939 objects takes about 27–37 ms per batch in JavaScript (≈ 1.7–2.3 µs per object) in a Web Worker, while rendering stays near 50–60 fps. These numbers are the baseline for the planned WebGPU port.

## Getting started

Requirements: Node.js 20+ (developed on Node 24 under WSL2/Ubuntu).

```bash
git clone git@github.com:oliviersci/orbit-lab.git
cd orbit-lab
npm install
npm run fetch-catalog   # downloads the current catalog from CelesTrak into public/data/
npm run dev             # starts the app at http://localhost:5173
npm test                # runs the validation suite
```

The catalog is not committed because it changes daily. Please respect CelesTrak's usage policy and refresh at most every couple of hours.

### Controls

| Key | Action |
|---|---|
| Mouse drag / scroll | Rotate / zoom |
| `Space` | Pause / resume |
| `]` / `[` | Double / halve time warp |
| `r` | Reset to current time, 1× speed |
| `m` | Show / hide simulated meoSphere |

## Project structure

```
src/
  core/
    time.ts            Epoch: UTC/TAI/TT/TDB, leap seconds
    bodies.ts          Body constants, frame-tagged StateVector, EphemerisProvider interface
    sun.ts             Low-precision Sun direction
    ga.ts              Geometric algebra G(3,0): bivectors, wedge product, rotors
  orbit/
    kepler.ts          Kepler's equation solver
    j2secular.ts       Mean-element J2 secular propagator
    walker.ts          Walker Delta generator, meoSphere phase 1 configuration
  propagation/
    sgp4.worker.ts     Catalog-wide SGP4 in a Web Worker
  render/
    earth.ts           Earth with graticule (body-fixed frame)
    constellation.ts   Simulated constellation layer with orbital-plane rings
  catalog/
    types.ts           Catalog types, operator colors
  main.ts              Scene, clock, HUD
scripts/
  fetch-catalog.ts     CelesTrak download, de-duplicated by operator
  diag-case.ts         Per-row diagnostics for SGP4 verification cases
test/
  sgp4/                SGP4 verification against AIAA 2006-6753
  orbit/               Rotor and J2 propagator tests
  fixtures/sgp4/       Pinned reference data with SHA-256 checksums
```

## Assumptions and limitations

- **meoSphere geometry:** SES has published 28 satellites, 4 planes, and ~8,000 km altitude for phase 1. Inclination (70°) and Walker phasing (F = 1) are assumptions, configurable in `src/orbit/walker.ts`.
- **J2 model:** first-order secular theory on mean elements; short-period J2 terms, drag, solar radiation pressure, and third-body effects are not modeled. Velocity omits the slow rotation of the orbital plane itself (|Ω̇|/n ≈ 3 × 10⁻⁴ at MEO).
- **Frames:** the scene uses TEME as its inertial frame; precession and nutation to GCRF are not yet applied. UT1 is approximated by UTC (≤ 0.9 s, about 0.4 km at the equator).
- **Catalog accuracy:** public element sets are predictions, typically hours to a day old. SGP4 accuracy is around 1 km at epoch and degrades by kilometers per day in LEO, especially for frequently maneuvering satellites.
- **SGP4 implementation:** currently uses satellite.js; an own implementation is next on the roadmap.

## Roadmap

- [x] Live catalog with operator classification and real-time SGP4
- [x] SGP4 validation harness against AIAA 2006-6753
- [x] Geometric algebra core and J2 secular propagator
- [x] Simulated meoSphere phase 1 layer
- [ ] Per-operator visibility toggles, satellite selection and info panel
- [ ] Python / Orekit comparison: J2 secular model against full numerical propagation
- [ ] Own SGP4 implementation, validated with the existing harness, including both operating modes to confirm case 23599
- [ ] WebGPU compute port of SGP4, with float32 precision error quantified against float64
- [ ] Numerical propagator: adaptive Dormand–Prince integrator, gravity field, lunar/solar third body, SRP, drag
- [ ] Constellation analysis: coverage, inter-satellite visibility, conjunction screening during deployment
- [ ] Earth–Moon extension: ephemerides, lunar frames, floating-origin rendering

## Data sources and references

- **Orbital elements:** [CelesTrak](https://celestrak.org), Dr. T.S. Kelso.
- **SGP4 verification data:** Vallado, D. A., Crawford, P., Hujsak, R., and Kelso, T. S., "Revisiting Spacetrack Report #3," AIAA/AAS Astrodynamics Specialist Conference, Keystone, CO, 2006, AIAA 2006-6753. Test elements (`SGP4-VER.TLE`) and reference output (`tmatverDec2015.out`) from the [CelesTrak distribution](https://celestrak.org/publications/AIAA/2006-6753/).
- **SGP4 library:** [satellite.js](https://github.com/shashwatak/satellite-js).
- **meoSphere public parameters:** SES and K2 Space announcement, March 2026.
- **Geometric algebra:** Hestenes, D., *New Foundations for Classical Mechanics*; Doran, C. and Lasenby, A., *Geometric Algebra for Physicists*.

## Author

Built by [@oliviersci](https://github.com/oliviersci), physics student, as a flight dynamics portfolio project.
