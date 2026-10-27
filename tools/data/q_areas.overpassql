[out:json][timeout:180];
(
  way["leisure"~"^(park|garden|pitch|stadium)$"](-1.3050,36.8000,-1.2680,36.8420);
  relation["leisure"~"^(park|garden)$"](-1.3050,36.8000,-1.2680,36.8420);
  way["landuse"~"^(grass|forest|recreation_ground|cemetery)$"](-1.3050,36.8000,-1.2680,36.8420);
  way["natural"~"^(water|wood|scrub|grassland)$"](-1.3050,36.8000,-1.2680,36.8420);
  relation["natural"="water"](-1.3050,36.8000,-1.2680,36.8420);
  way["amenity"="parking"](-1.3050,36.8000,-1.2680,36.8420);
);
out geom;
