// Pedestrians are a later phase (ROADMAP.md phase 3): Slop New York's pedestrian-system.js walks people along the
// sidewalks and crosswalks of Manhattan's blocks, which Nairobi doesn't have yet. Until then this stands in for it with
// the same interface and nobody walking: every junction's walkers list is empty, so the traffic's crosswalk checks
// (traffic.js pedestrianOn) always find the crossings clear.

function createPedestrianSystem(network) {
  for (const n of network.nodes) {
    n.walkers = [];
    n.curb = null;
  }
  return {
    meshes: [],
    peds: [],
    update() {}
  };
}

export { createPedestrianSystem };
