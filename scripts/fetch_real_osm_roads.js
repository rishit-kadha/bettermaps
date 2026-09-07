const https = require('https');
const fs = require('fs');
const path = require('path');

// Geographic bounding box covering Coventry City Centre, Ring Road, University, Puma Way, Mile Ln, Warwick Rd, Kenilworth Rd
// S: 52.388, W: -1.535, N: 52.420, E: -1.490
const BBOX = '52.388,-1.535,52.420,-1.490';
const QUERY = `[out:json][timeout:30];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified)$"](${BBOX});
);
out geom;
`;

console.log('Querying OpenStreetMap Overpass API for real Coventry road network...');
const url = 'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(QUERY);

const req = https.get(url, { headers: { 'User-Agent': 'BetterMaps/1.0 (SIH Dead Reckoning Evaluation)' } }, (res) => {
  if (res.statusCode !== 200) {
    console.error(`Overpass API returned status ${res.statusCode}`);
    res.resume();
    return;
  }

  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      console.log(`Received ${json.elements.length} real road ways from OpenStreetMap!`);
      
      const ways = json.elements.filter(e => e.type === 'way' && e.geometry && e.geometry.length >= 2);
      console.log(`Valid road ways with geometry: ${ways.length}`);

      // Inspect some road names
      const roadNames = new Set();
      ways.forEach(w => {
        if (w.tags && w.tags.name) roadNames.add(w.tags.name);
      });
      console.log(`Discovered ${roadNames.size} named roads in Coventry, including:`);
      console.log(Array.from(roadNames).slice(0, 20).join(', '));

      fs.writeFileSync(path.join(__dirname, 'osm_coventry_raw.json'), JSON.stringify(json, null, 2));
      console.log('Saved to scripts/osm_coventry_raw.json');
    } catch (e) {
      console.error('Failed to parse JSON:', e.message);
      console.log('Raw response head:', data.slice(0, 300));
    }
  });
});

req.on('error', err => {
  console.error('Request failed:', err.message);
});
