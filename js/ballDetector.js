/*
  ballDetector.js (version 2) - finds the basketball near the hoop.

  What changed from version 1, and why:

  1. ONLY LOOK NEAR THE HOOP, IN MORE DETAIL.
     Version 1 shrank the WHOLE picture to 192 px wide, so a ball far away
     became ~4 pixels and disappeared. Now we cut out a "tracking zone"
     around the hoop (4 rim-widths left and right, 7 above, 3 below) and
     analyse THAT at up to 320 px wide. The ball is now ~5x bigger to us,
     and anything moving far from the hoop (people, orange shirts) is ignored.

  2. FIND THE WHOLE BALL BY MOVEMENT, NOT COLOUR.
     We keep a "background picture" of the zone: what it looks like when
     nothing is moving. Every new frame is compared with it. Pixels that are
     very different belong to something new in the scene, the "foreground".
     The ball is a foreground blob of the right SIZE and SHAPE.
     Colour is now optional (tap the ball during setup to switch it on).

  3. USE THE RIM AS A RULER.
     A basketball is about half as wide as a rim (24 cm vs 45 cm). Because
     you drew a box around the rim, we know how big the ball should look,
     so blobs that are much too small (noise) or too big (a person) are rejected.

  4. HANDLE FAST, BLURRED BALLS.
     A fast ball looks like a streak, not a circle. We judge size by the
     streak's SHORT side and allow it to be up to 3x longer than wide.

  5. PREDICT WHERE THE BALL GOES NEXT.
     If we know where the ball was and how fast it moved, we pick the blob
     nearest to where it should be now, instead of just the biggest one.
*/

class BallDetector {
  constructor() {
    this.mode = "shape";       // "shape" = any colour, "colour" = must also match the ball's colour
    this.targetHue = 25;       // ball colour in degrees (used only in "colour" mode)
    this.hueTolerance = 20;
    this.sensitivity = 22;     // how much a pixel must change to count as foreground (lower = more sensitive)
    this.maxWorkWidth = 320;   // the most pixels across we analyse (more = slower)

    this.zone = null;          // {x, y, w, h} normalised area we analyse
    this.workW = 0;            // size of the zone in analysis pixels
    this.workH = 0;
    this.rimPx = 0;            // rim width in analysis pixels: our ruler
    this.background = null;    // Float32Array: the average "empty" zone, one number per pixel
    this.candidates = [];      // every blob that passed the checks, for the detection view
    this.canvas = null;
  }

  // Keep a number between lo and hi.
  static clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  // Same as version 1: RGB (0-255) -> [hue 0-360, saturation 0-1, brightness 0-1]
  static rgbToHsv(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return [h, max === 0 ? 0 : d / max, max / 255];
  }

  static hueDistance(a, b) {
    const d = Math.abs(a - b);
    return Math.min(d, 360 - d);
  }

  /*
    Work out the tracking zone from the rim box.
    hoop: normalised {x, y, w, h}. videoW/videoH: camera size in pixels.
  */
  setHoop(hoop, videoW, videoH) {
    const C = BallDetector.clamp;
    // hoop.w is a fraction of the WIDTH. To measure UP and DOWN in the same
    // real-world distance we convert it to a fraction of the HEIGHT.
    const rimW = hoop.w;
    const rimWy = hoop.w * (videoW / videoH);
    const x0 = C(hoop.x - 4 * rimW, 0, 1);
    const x1 = C(hoop.x + hoop.w + 4 * rimW, 0, 1);
    const y0 = C(hoop.y - 7 * rimWy, 0, 1);
    const y1 = C(hoop.y + hoop.h + 3 * rimWy, 0, 1);
    this.zone = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };

    // Scale the zone down only if it is wider than maxWorkWidth (never enlarge it).
    const zoneW = this.zone.w * videoW;
    const zoneH = this.zone.h * videoH;
    const scale = Math.min(1, this.maxWorkWidth / zoneW);
    this.workW = Math.max(8, Math.round(zoneW * scale));
    this.workH = Math.max(8, Math.round(zoneH * scale));
    this.rimPx = rimW * videoW * scale;
    this.resetBackground();
  }

  // Forget the background, e.g. after the brightness changes. It rebuilds in a moment.
  resetBackground() {
    this.background = null;
  }

  /*
    The core: find ball candidates in the zone's pixels.
    data: RGBA pixels of the zone, w x h.
    Returns a list of candidates in ZONE pixel coordinates (best guesses first).
  */
  findCandidates(data, w, h) {
    const n = w * h;
    /*
      FIX (version 2.2): compare COLOUR, not just brightness.
      Before, every pixel was turned into one grey number, so an orange ball
      in front of grey concrete of the same brightness looked identical to it
      and was invisible. Now we keep Red, Green and Blue separately
      (3 numbers per pixel) and look at the biggest change of the three.
    */
    const rgb = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      rgb[i * 3] = data[i * 4];          // red
      rgb[i * 3 + 1] = data[i * 4 + 1];  // green
      rgb[i * 3 + 2] = data[i * 4 + 2];  // blue
    }

    // First frame (or after a reset): this frame becomes the background.
    if (!this.background || this.background.length !== n * 3) {
      this.background = rgb;
      return [];
    }

    // 1. Foreground mask: pixels where red, green OR blue changed a lot.
    const bg = this.background;
    const fg = new Uint8Array(n);
    let fgCount = 0;
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      const change = Math.max(
        Math.abs(rgb[j] - bg[j]),
        Math.abs(rgb[j + 1] - bg[j + 1]),
        Math.abs(rgb[j + 2] - bg[j + 2]),
      );
      if (change > this.sensitivity) {
        fg[i] = 1;
        fgCount++;
      }
    }

    // If more than a third of the zone "changed" at once, the camera's brightness
    // jumped (or the phone moved). Start the background again instead of
    // seeing hundreds of fake blobs.
    if (fgCount > n * 0.35) {
      this.background = rgb;
      return [];
    }

    // 2. Update the background slowly so it follows gentle light changes.
    // Background pixels learn fast (10%), foreground pixels very slowly (0.5%),
    // so the moving ball does not get "learned" into the background.
    for (let i = 0; i < n; i++) {
      const rate = fg[i] ? 0.005 : 0.1;
      for (let c = 0; c < 3; c++) {
        const j = i * 3 + c;
        bg[j] += rate * (rgb[j] - bg[j]);
      }
    }

    // 3. Group foreground pixels into blobs (flood fill, like version 1).
    const labels = new Int32Array(n);
    const stack = new Int32Array(n);
    const expected = this.rimPx * 0.53;            // expected ball diameter from the rim ruler
    const minSide = Math.max(2, this.rimPx * 0.2); // smallest acceptable ball (far away)
    const maxSide = Math.max(4, this.rimPx * 1.1); // biggest acceptable ball (close to camera)
    const found = [];
    let label = 0;

    for (let start = 0; start < n; start++) {
      if (!fg[start] || labels[start]) continue;
      label++;
      let top = 0;
      stack[top++] = start;
      labels[start] = label;
      let count = 0, sumX = 0, sumY = 0, colourCount = 0;
      let minX = w, maxX = 0, minY = h, maxY = 0;

      while (top > 0) {
        const p = stack[--top];
        const x = p % w;
        const y = (p - x) / w;
        count++; sumX += x; sumY += y;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (this.mode === "colour") {
          const [hue, sat, val] = BallDetector.rgbToHsv(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]);
          // Loose limits: a ball in glare or shade is pale or dark but keeps roughly its hue.
          if (sat > 0.15 && val > 0.12 && BallDetector.hueDistance(hue, this.targetHue) <= this.hueTolerance) {
            colourCount++;
          }
        }
        if (x > 0     && fg[p - 1] && !labels[p - 1]) { labels[p - 1] = label; stack[top++] = p - 1; }
        if (x < w - 1 && fg[p + 1] && !labels[p + 1]) { labels[p + 1] = label; stack[top++] = p + 1; }
        if (y > 0     && fg[p - w] && !labels[p - w]) { labels[p - w] = label; stack[top++] = p - w; }
        if (y < h - 1 && fg[p + w] && !labels[p + w]) { labels[p + w] = label; stack[top++] = p + w; }
      }

      // 4. The checks.
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const shortSide = Math.min(bw, bh);
      const longSide = Math.max(bw, bh);
      const fill = count / (bw * bh);                 // how solid the blob is
      if (shortSide < minSide || shortSide > maxSide) continue;  // wrong size for a ball
      if (longSide / shortSide > 3) continue;         // too stretched, even for a blurred ball
      if (fill < 0.4) continue;                       // too hollow/stringy (e.g. the net, an arm)
      if (this.mode === "colour" && colourCount / count < 0.25) continue;  // wrong colour

      // Score: solid and close to the expected ball size scores highest.
      const sizeError = Math.abs(shortSide / expected - 1);
      found.push({
        x: sumX / count + 0.5,
        y: sumY / count + 0.5,
        size: shortSide,
        score: fill - 0.5 * sizeError,
        box: [minX, minY, bw, bh],
      });
    }

    // Best score first. .sort() with this function puts higher scores at the front.
    found.sort((a, b) => b.score - a.score);
    return found;
  }

  /*
    Browser: grab the zone from the video and find the ball.
    predicted: optional normalised {x, y} where the ball should be now.
    Returns normalised {x, y, r} or null.
  */
  detect(video, predicted = null) {
    if (!this.zone || !video.videoWidth) return null;
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    }
    if (this.canvas.width !== this.workW || this.canvas.height !== this.workH) {
      this.canvas.width = this.workW;
      this.canvas.height = this.workH;
    }
    const vw = video.videoWidth, vh = video.videoHeight;
    const z = this.zone;
    // drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh):
    // copy the rectangle (sx, sy, sw, sh) of the video into a (dw x dh) canvas.
    this.ctx.drawImage(video, z.x * vw, z.y * vh, z.w * vw, z.h * vh, 0, 0, this.workW, this.workH);
    const img = this.ctx.getImageData(0, 0, this.workW, this.workH);
    return this.pick(this.findCandidates(img.data, this.workW, this.workH), predicted);
  }

  /*
    Turn zone-pixel candidates into normalised positions and choose one.
    Kept separate from detect() so the test file can use it without a browser.
  */
  pick(found, predicted) {
    const z = this.zone;
    this.candidates = found.map((c) => ({     // .map makes a new list by converting every item
      x: z.x + (c.x / this.workW) * z.w,
      y: z.y + (c.y / this.workH) * z.h,
      r: (c.size / 2 / this.workW) * z.w,
      box: c.box,
    }));
    if (this.candidates.length === 0) return null;
    if (!predicted) return this.candidates[0];

    // With a prediction: take the candidate closest to it, if it's close enough.
    // "Close enough" = within 3 rim-widths.
    const rimW = (this.rimPx / this.workW) * z.w;
    let best = null, bestDist = Infinity;
    for (const c of this.candidates) {
      const d = Math.hypot(c.x - predicted.x, c.y - predicted.y);  // straight-line distance
      if (d < bestDist) { bestDist = d; best = c; }
    }
    return bestDist <= rimW * 3 ? best : this.candidates[0];
  }

  /*
    Setup: the user taps the ball. Read its colour from a small square around
    the tap at full camera resolution, and switch to "colour" mode.
  */
  sampleColour(video, nx, ny) {
    if (!video.videoWidth) return null;
    const c = document.createElement("canvas");
    c.width = c.height = 9;
    const cctx = c.getContext("2d", { willReadFrequently: true });
    const vw = video.videoWidth, vh = video.videoHeight;
    // Copy a square 1% of the picture's width around the tap.
    const s = Math.max(6, vw * 0.01);
    cctx.drawImage(video, nx * vw - s / 2, ny * vh - s / 2, s, s, 0, 0, 9, 9);
    const d = cctx.getImageData(0, 0, 9, 9).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const px = d.length / 4;
    r /= px; g /= px; b /= px;
    const [hue, sat] = BallDetector.rgbToHsv(r, g, b);
    if (sat < 0.12) return null;              // grey or white: not useful as a colour
    this.targetHue = hue;
    this.mode = "colour";
    return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
  }
}

if (typeof module !== "undefined") module.exports = { BallDetector };
