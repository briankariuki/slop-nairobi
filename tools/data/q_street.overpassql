[out:json][timeout:180];
// Street furniture: traffic signals, pedestrian crossings, street lamps, trees and tree rows
(
  node["highway"="traffic_signals"](-1.3050,36.8000,-1.2680,36.8420);
  node["crossing"="traffic_signals"](-1.3050,36.8000,-1.2680,36.8420);
  node["highway"="crossing"](-1.3050,36.8000,-1.2680,36.8420);
  way["footway"="crossing"](-1.3050,36.8000,-1.2680,36.8420);
  node["highway"="street_lamp"](-1.3050,36.8000,-1.2680,36.8420);
  node["natural"="tree"](-1.3050,36.8000,-1.2680,36.8420);
  way["natural"="tree_row"](-1.3050,36.8000,-1.2680,36.8420);
);
out geom;
