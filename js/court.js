/*
  court.js - draws the half court for the spot picker and the session report.

  The drawing is an SVG (a picture made of shapes described in text).
  Measurements use 10 units = 1 foot, like a real court:
  the court is 50 ft wide (500 units), the hoop is 5.25 ft from the baseline
  (y = 52.5), and the three-point arc has a radius of 23.75 ft (237.5).
*/

// The 9 shooting spots. x, y = where the spot sits on the drawing.
const SPOTS = [
  { id: "lc",    name: "Left corner",  label: "Corner",  x: 15,  y: 70 },
  { id: "lw",    name: "Left wing",    label: "Wing",    x: 72,  y: 236 },
  { id: "top",   name: "Top of key",   label: "Top",     x: 250, y: 318 },
  { id: "rw",    name: "Right wing",   label: "Wing",    x: 428, y: 236 },
  { id: "rc",    name: "Right corner", label: "Corner",  x: 485, y: 70 },
  { id: "le",    name: "Left elbow",   label: "Elbow",   x: 170, y: 190 },
  { id: "ft",    name: "Free throw",   label: "FT line", x: 250, y: 205 },
  { id: "re",    name: "Right elbow",  label: "Elbow",   x: 330, y: 190 },
  { id: "paint", name: "Paint",        label: "Paint",   x: 250, y: 115 },
];

// What part of the drawing to show: x from -30, y from -10, 560 wide, 380 tall.
const COURT_VIEWBOX = "-30 -10 560 380";

// The court lines, drawn once and reused.
const COURT_LINES = `
  <rect class="floor" x="-30" y="-10" width="560" height="380" rx="12"/>
  <path class="lines" d="M0 370 V0 H500 V370"/>
  <rect class="lines" x="170" y="0" width="160" height="190"/>
  <circle class="lines" cx="250" cy="190" r="60"/>
  <path class="lines" d="M30 0 V140 A237.5 237.5 0 0 0 470 140 V0"/>
  <line class="lines" x1="220" y1="40" x2="280" y2="40"/>
  <circle class="rim" cx="250" cy="52.5" r="9"/>`;

const Court = {
  spots: SPOTS,

  // Find a spot by its id, e.g. Court.byId("lw") -> the Left wing object.
  byId(id) {
    return SPOTS.find((s) => s.id === id) || null;
  },

  // Spot picker: every spot is a tappable circle; the chosen one is highlighted.
  renderPicker(svg, selectedId) {
    svg.setAttribute("viewBox", COURT_VIEWBOX);
    svg.innerHTML = COURT_LINES + SPOTS.map((s) => `
      <g class="spot pick${s.id === selectedId ? " selected" : ""}" data-spot="${s.id}"
         tabindex="0" role="button" aria-label="${s.name}">
        <circle cx="${s.x}" cy="${s.y}" r="31"/>
        <text x="${s.x}" y="${s.y}" font-size="15">${s.label}</text>
      </g>`).join("");   // .join("") glues the list of strings into one string
  },

  /*
    Report: each spot coloured by its shooting percentage.
    stats = { lw: { made: 3, att: 5 }, ... }
  */
  renderReport(svg, stats) {
    svg.setAttribute("viewBox", COURT_VIEWBOX);
    svg.innerHTML = COURT_LINES + SPOTS.map((s) => {
      const st = stats[s.id];
      if (!st || st.att === 0) {
        // Not shot from this spot: a faint dashed circle.
        return `<g class="spot none"><circle cx="${s.x}" cy="${s.y}" r="31"/>
                <text x="${s.x}" y="${s.y}" font-size="15">${s.label}</text></g>`;
      }
      const pct = (st.made / st.att) * 100;
      // Colour bands: 50%+ green, 35-49% amber, under 35% red.
      const band = pct >= 50 ? "hot" : pct >= 35 ? "warm" : "cold";
      return `<g class="spot ${band}">
          <circle cx="${s.x}" cy="${s.y}" r="31"/>
          <text x="${s.x}" y="${s.y - 7}" font-size="20">${Math.round(pct)}%</text>
          <text x="${s.x}" y="${s.y + 13}" font-size="13">${st.made}/${st.att}</text>
        </g>`;
    }).join("");
  },
};

if (typeof module !== "undefined") module.exports = { Court, SPOTS };
