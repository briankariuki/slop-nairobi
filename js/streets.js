import * as THREE from 'three/webgpu';
import { layoutStreets, setStreetLayout, streetSoups } from './street-geometry.js';
import { buildRoadPaint } from './road-paint.js';
import { createRoadSurfaceMaterial, createSidewalkMaterial, createCurbMaterial } from './tsl-materials.js';

// The streets' meshes (street-geometry.js lays them out): asphalt, sidewalk paving, kerbs and footpaths, then the road
// markings over them (road-paint.js). Built from the traffic's road network, so it comes after createTrafficSystem; from
// then on pavementLift (street-geometry.js) tells the pedestrians and the player how high the ground is raised.

function mesh(s, material, name) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(s.pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(s.nrm, 3));
  geo.setIndex(s.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(s.index, 1) : new THREE.Uint16BufferAttribute(s.index, 1));
  geo.computeBoundingSphere();
  const m = new THREE.Mesh(geo, material);
  m.name = name;
  m.matrixAutoUpdate = false;
  return m;
}

export function buildStreets(scene, network, zebras) {
  const t0 = performance.now();
  const layout = layoutStreets(network.streets);
  setStreetLayout(layout);
  const soups = streetSoups(layout);
  const group = new THREE.Group();
  group.name = 'streets';
  group.add(
    mesh(soups.asphalt, createRoadSurfaceMaterial(), 'asphalt'),
    mesh(soups.sidewalk, createSidewalkMaterial(0), 'sidewalks'),
    mesh(soups.kerb, createCurbMaterial(), 'kerbs'),
    mesh(soups.path, createSidewalkMaterial(1), 'footpaths')
  );
  scene.add(group);
  const paint = buildRoadPaint(scene, network, zebras);
  const tris = Object.values(soups).reduce((n, s) => n + s.index.length / 3, 0) + paint.geometry.index.count / 3;
  console.log(`[nairobi] streets in ${Math.round(performance.now() - t0)} ms: ${layout.carriageways.list.length} carriageway and junction pieces, ${layout.sidewalks.list.length} sidewalk pieces, ${layout.paths.list.length} footpath pieces, ${Math.round(tris / 1000)}k triangles`);
  group.userData.layout = layout;
  return group;
}
