// tools/fetch-terrain.mjs — downloads the Copernicus GLO-30 elevation window around tools/bbox.json to
// tools/data/dem_glo30.json. The tile is a cloud-optimised GeoTIFF on AWS Open Data, so only the window is fetched.
// usage: node tools/fetch-terrain.mjs
//
// GLO-30 is a surface model (DSM): it includes buildings and trees. tools/build-geodata.mjs filters it to bare ground.
// Produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided
// under COPERNICUS by the European Union and ESA; all rights reserved.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromUrl } from 'geotiff';

const BBOX = JSON.parse(fs.readFileSync(fileURLToPath(new URL('bbox.json', import.meta.url)), 'utf8'));
const OUT = fileURLToPath(new URL('data/dem_glo30.json', import.meta.url));
const MARGIN = 0.005; // ~550 m beyond the bbox, so filtering has context at the edges

const tileName = (lat, lon) => {
  const la = Math.floor(lat);
  const lo = Math.floor(lon);
  const ns = `${la < 0 ? 'S' : 'N'}${String(Math.abs(la)).padStart(2, '0')}_00`;
  const ew = `${lo < 0 ? 'W' : 'E'}${String(Math.abs(lo)).padStart(3, '0')}_00`;
  return `Copernicus_DSM_COG_10_${ns}_${ew}_DEM`;
};
const [s, w, n, e] = [BBOX.south - MARGIN, BBOX.west - MARGIN, BBOX.north + MARGIN, BBOX.east + MARGIN];
const name = tileName(s, w);
if (name !== tileName(n, e)) throw new Error('the bbox crosses a 1° tile boundary; extend this script to mosaic tiles');

const tiff = await fromUrl(`https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif`);
const image = await tiff.getImage();
const [west0, , , north0] = image.getBoundingBox();
const [dx, dy] = image.getResolution(); // dy < 0: rows run south
const c0 = Math.floor((w - west0) / dx);
const c1 = Math.ceil((e - west0) / dx);
const r0 = Math.floor((n - north0) / dy);
const r1 = Math.ceil((s - north0) / dy);
const [band] = await image.readRasters({ window: [c0, r0, c1, r1] });

const out = {
  source: `${name} (Copernicus GLO-30 DSM)`,
  west: west0 + c0 * dx, // lon of the first column's west edge
  north: north0 + r0 * dy, // lat of the first row's north edge
  dx,
  dy,
  nx: c1 - c0,
  ny: r1 - r0,
  values: Array.from(band, (v) => Math.round(v * 10) / 10) // metres above the EGM2008 geoid, row-major from the north-west
};
fs.writeFileSync(OUT, JSON.stringify(out));
const vals = out.values;
console.log(`[terrain] ${name}: ${out.nx}×${out.ny} cells, ${Math.min(...vals)}–${Math.max(...vals)} m → ${OUT}`);
