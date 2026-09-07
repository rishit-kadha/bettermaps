/**
 * generate_sih_outage_plots.js
 *
 * Generates an SVG plot showing Instantaneous Position Error (meters)
 * vs Elapsed Outage Time (0 to 30 seconds) for all evaluated IO-VNBD benchmark sessions.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = process.cwd();
const dataPath = path.join(repoRoot, 'artifacts/device_evaluation/all_sessions_sih_benchmark.json');
const rawData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

// Filter sessions with valid timeSeries
const validSessions = rawData.filter(s => s.timeSeries && s.timeSeries.length > 0);

// Colors for distinct curves
const COLORS = {
  S1: '#00E5FF',     // Bright Cyan
  Vta8: '#00E676',   // Bright Green
  S2: '#FFD600',     // Yellow
  M: '#FF9100',      // Orange
  Vtb4: '#E040FB',   // Pink / Magenta
  Vw8: '#7C4DFF',    // Deep Purple
  Vtb12: '#536DFE',  // Indigo
  Vta15: '#29B6F6',  // Light Blue
  Vta21: '#AB47BC',  // Violet
  Vw14b: '#FF5252',  // Red
  Vta10: '#D50000',  // Dark Red
  Vtb10: '#78909C',  // Slate
};

// Canvas dimensions
const W = 1000;
const H = 600;
const PADDING = { top: 60, right: 240, bottom: 60, left: 80 };
const PLOT_W = W - PADDING.left - PADDING.right;
const PLOT_H = H - PADDING.top - PADDING.bottom;

// Time range: 0 to 30 seconds
const T_MAX = 30.0;
// We'll plot two versions: Full Scale (up to 1100m) and Zoomed Detail (up to 150m)
function generateSvg(maxErrorY, title, filename) {
  const xScale = (t) => PADDING.left + (Math.min(t, T_MAX) / T_MAX) * PLOT_W;
  const yScale = (e) => PADDING.top + PLOT_H - (Math.min(e, maxErrorY) / maxErrorY) * PLOT_H;

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="background:#0F172A; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;">
  <defs>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="2" result="blur" />
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>

  <!-- Title & Subtitle -->
  <text x="${PADDING.left}" y="32" fill="#F8FAFC" font-size="18" font-weight="700">${title}</text>
  <text x="${PADDING.left}" y="50" fill="#94A3B8" font-size="12">Evaluation during GNSS-Denied Outage Window (t = 20s to 50s, Duration = 30s) · GRU + ESKF + NHC + Road + Route</text>

  <!-- Grid lines -->
  <rect x="${PADDING.left}" y="${PADDING.top}" width="${PLOT_W}" height="${PLOT_H}" fill="#1E293B" rx="4" stroke="#334155" stroke-width="1"/>
`;

  // Horizontal Grid Lines (Y-axis)
  const ySteps = 6;
  for (let i = 0; i <= ySteps; i++) {
    const val = (maxErrorY / ySteps) * i;
    const y = yScale(val);
    svg += `  <line x1="${PADDING.left}" y1="${y}" x2="${PADDING.left + PLOT_W}" y2="${y}" stroke="#334155" stroke-width="1" stroke-dasharray="${i === 0 ? 'none' : '4,4'}"/>\n`;
    svg += `  <text x="${PADDING.left - 12}" y="${y + 4}" fill="#94A3B8" font-size="11" text-anchor="end">${Math.round(val)}m</text>\n`;
  }

  // Vertical Grid Lines (X-axis, every 5s)
  for (let t = 0; t <= T_MAX; t += 5) {
    const x = xScale(t);
    svg += `  <line x1="${x}" y1="${PADDING.top}" x2="${x}" y2="${PADDING.top + PLOT_H}" stroke="#334155" stroke-width="1" stroke-dasharray="${t === 0 ? 'none' : '4,4'}"/>\n`;
    svg += `  <text x="${x}" y="${PADDING.top + PLOT_H + 20}" fill="#94A3B8" font-size="11" text-anchor="middle">${t}s</text>\n`;
  }

  // X Axis Label
  svg += `  <text x="${PADDING.left + PLOT_W / 2}" y="${PADDING.top + PLOT_H + 45}" fill="#CBD5E1" font-size="12" font-weight="600" text-anchor="middle">Elapsed Outage Time (seconds)</text>\n`;

  // Y Axis Label
  svg += `  <text x="${-PADDING.top - PLOT_H / 2}" y="24" fill="#CBD5E1" font-size="12" font-weight="600" text-anchor="middle" transform="rotate(-90)">Position Error e_pos(t) (meters)</text>\n`;

  // Draw curves
  // Draw less accurate sessions first, top sessions last (on top)
  const sortedToDraw = [...validSessions].sort((a, b) => (b.endpointErrorM || 0) - (a.endpointErrorM || 0));

  sortedToDraw.forEach(s => {
    const color = COLORS[s.sessionId] || '#94A3B8';
    const isTop5 = ['Vta8', 'S2', 'M', 'S1', 'Vtb4'].includes(s.sessionId);
    const strokeWidth = isTop5 ? 3 : 1.5;
    const opacity = isTop5 ? 1.0 : 0.45;

    let pathD = '';
    s.timeSeries.forEach((pt, idx) => {
      const x = xScale(pt.outageSec);
      const y = yScale(pt.errorM);
      pathD += (idx === 0 ? `M ${x.toFixed(1)} ${y.toFixed(1)}` : ` L ${x.toFixed(1)} ${y.toFixed(1)}`);
    });

    svg += `  <!-- Session ${s.sessionId} -->\n`;
    svg += `  <path d="${pathD}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" opacity="${opacity}" ${isTop5 ? 'filter="url(#glow)"' : ''}/>\n`;

    // Last point marker
    if (s.timeSeries.length > 0) {
      const last = s.timeSeries[s.timeSeries.length - 1];
      const lx = xScale(last.outageSec);
      const ly = yScale(last.errorM);
      svg += `  <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="${isTop5 ? 4 : 2.5}" fill="${color}"/>\n`;
    }
  });

  // Legend Card (Right side)
  const legendX = PADDING.left + PLOT_W + 20;
  let legendY = PADDING.top + 10;
  svg += `  <!-- Legend Box -->\n`;
  svg += `  <rect x="${legendX - 10}" y="${PADDING.top}" width="${PADDING.right - 25}" height="${PLOT_H}" fill="#1E293B" rx="6" stroke="#334155" stroke-width="1"/>\n`;
  svg += `  <text x="${legendX}" y="${legendY}" fill="#F8FAFC" font-size="12" font-weight="700">RANKED SESSIONS</text>\n`;
  legendY += 18;

  // Render legend items in order of least error
  const legendSessions = [...validSessions].sort((a, b) => a.endpointErrorM - b.endpointErrorM);

  legendSessions.forEach((s, idx) => {
    const color = COLORS[s.sessionId] || '#94A3B8';
    const isTop = idx < 5;
    svg += `  <g opacity="${isTop ? 1.0 : 0.65}">\n`;
    svg += `    <rect x="${legendX}" y="${legendY - 8}" width="14" height="4" fill="${color}" rx="2"/>\n`;
    svg += `    <circle cx="${legendX + 7}" cy="${legendY - 6}" r="3" fill="${color}"/>\n`;
    svg += `    <text x="${legendX + 22}" y="${legendY - 2}" fill="${isTop ? '#F8FAFC' : '#94A3B8'}" font-size="11" font-weight="${isTop ? '600' : '400'}">#${idx + 1} ${s.sessionId.padEnd(6)}</text>\n`;
    svg += `    <text x="${legendX + 130}" y="${legendY - 2}" fill="${color}" font-size="11" font-weight="600" text-anchor="end">${s.endpointErrorM.toFixed(1)}m</text>\n`;
    svg += `  </g>\n`;
    legendY += 21;
  });

  svg += `</svg>`;

  fs.writeFileSync(filename, svg, 'utf8');
  console.log(`Generated SVG plot: ${filename}`);
}

// 1. Zoomed Detail Plot (0 to 150m) focusing on Top Performing Sessions
generateSvg(
  150,
  'GNSS Outage Position Error vs Elapsed Time — Top Sessions (Detail 0-150m)',
  path.join(repoRoot, 'artifacts/device_evaluation/outage_error_detail_top.svg')
);

// 2. Full Overview Plot (0 to 1100m) with all 12 Sessions
generateSvg(
  1100,
  'GNSS Outage Position Error vs Elapsed Time — All 12 Benchmark Sessions (Overview 0-1100m)',
  path.join(repoRoot, 'artifacts/device_evaluation/outage_error_overview_all.svg')
);
