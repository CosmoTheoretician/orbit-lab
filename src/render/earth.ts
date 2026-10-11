import * as THREE from "three";

const DEG = Math.PI / 180;

function onSphere(r: number, latDeg: number, lonDeg: number): THREE.Vector3 {
  const lat = latDeg * DEG, lon = lonDeg * DEG;
  return new THREE.Vector3(r * Math.cos(lat) * Math.cos(lon), r * Math.cos(lat) * Math.sin(lon), r * Math.sin(lat));
}

/** Earth in its body-fixed frame (Z = north pole, X = Greenwich). Units: km. */
export function createEarth(radiusKm: number): THREE.Group {
  const group = new THREE.Group();

  const geo = new THREE.SphereGeometry(radiusKm, 96, 64);
  geo.rotateX(Math.PI / 2); // three.js puts poles on Y; we use Z
  group.add(new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ color: 0x1d3b5a, shininess: 8 })));

  const r = radiusKm * 1.001;
  const gridMat = new THREE.LineBasicMaterial({ color: 0x4f7aa3, transparent: true, opacity: 0.45 });
  const keyMat = new THREE.LineBasicMaterial({ color: 0xffcc33 });

  for (let lon = -180; lon < 180; lon += 30) {
    const pts: THREE.Vector3[] = [];
    for (let lat = -90; lat <= 90; lat += 2) pts.push(onSphere(r, lat, lon));
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lon === 0 ? keyMat : gridMat));
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const pts: THREE.Vector3[] = [];
    for (let lon = -180; lon <= 180; lon += 2) pts.push(onSphere(r, lat, lon));
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lat === 0 ? keyMat : gridMat));
  }
  return group;
}