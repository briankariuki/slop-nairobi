[out:json][timeout:180];
(
  way["waterway"~"^(river|stream|canal|drain)$"](-1.3050,36.8000,-1.2680,36.8420);
  way["railway"~"^(rail|light_rail|platform)$"](-1.3050,36.8000,-1.2680,36.8420);
  nwr["railway"~"^(station|halt)$"](-1.3050,36.8000,-1.2680,36.8420);
  nwr["public_transport"="station"]["train"="yes"](-1.3050,36.8000,-1.2680,36.8420);
  node["highway"="bus_stop"](-1.3050,36.8000,-1.2680,36.8420);
  node["amenity"="bus_station"](-1.3050,36.8000,-1.2680,36.8420);
  way["amenity"="bus_station"](-1.3050,36.8000,-1.2680,36.8420);
);
out geom;
