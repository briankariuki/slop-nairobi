# Roadmap: Slop New York, for Nairobi

The goal is everything [Slop New York](https://github.com/mrdoob/slop-newyork) has (walking, driving, cycling and flying, traffic, crowds, signals, cameras, the map, audio), set in Nairobi's CBD.

New York's code assumes three things Nairobi breaks:
- **A rectangular grid.** Its road network is derived from Manhattan's rectangular kerb blocks.
- **Flat ground.** Everything sits at y = 0.
- **Driving on the right.**

So the work is mostly a new road network, plus adapting the systems that use it. Much of the rest carries over almost unchanged.

| Slop New York module | Plan |
|---|---|
| `actor-models`, `pedestrians` (rigs and animation), `vehicle-physics`, `vehicle-lights`, `lighting`, `post-processing`, `audio-*`, `touch-controls`, `gamepad-controls`, `cameras`, `trees`, `street-props` | Reuse with small changes |
| `road-network` | **Rebuild** from OSM centrelines, with the same interface |
| `traffic`, `pedestrian-system`, `pedestrian-routes`, `road-paint`, `controllers`, `nyc-map`, `audio-sources` | Adapt: terrain heights, left-hand traffic, roundabouts |
| `city-grid`, `boroughs`, `buildings`, `landmarks`, `fire-escapes`, `subway-entrances`, `street-details`, `city-config` | Replace with Nairobi's own (`ground`, `buildings`, `bridges`, …) |

## Phases

1. **Road network.** Build a graph from OSM: 4,447 junctions, left-hand lanes, roundabouts (149 segments), the 13 mapped signals plus generated ones at major junctions, the Expressway as elevated lanes, and kerbs and sidewalks from road widths.
2. **Traffic.** Port `traffic.js` onto that network, driving on the left on terrain. Add Nairobi vehicles: matatus, buses and boda bodas alongside cars. *Done.*
3. **People.** Port `pedestrian-system` with sidewalks, crossings and walk signals. *Done: crosswalks at signalised junctions, OSM zebra crossings (40 placed, signal-controlled ones skipped) and occasional jaywalking. No raised kerbs yet. Right turns at busy signals can lose a green to people still on the crosswalk, which backs queues up for a cycle or two.*
4. **Player.** Port the walk, drive, cycle and helicopter controllers and cameras onto terrain, with buildings as colliders.
5. **Looks.** New York's materials (window facades), roof shapes for the towers, shadows, trees, street lamps and signal heads. Roads as geometry instead of paint on the ground texture, which at ~1.15 m per texel blurs them and drops their markings: carriageways draped on the terrain, junction fills, raised kerbs and sidewalks matching `walk-grid.js` (Phase 1's kerbs and sidewalks were skipped), and `road-paint` ported for lane markings, stop lines and crosswalks.
6. **The rest.** The Nairobi map and teleports, landmark labels, and audio (hooting, matatu music).
