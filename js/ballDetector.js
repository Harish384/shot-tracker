/*
  ballDetector.js - finds the basketball in one camera frame.

  How it works (3 checks a blob must pass to count as "the ball"):
    1. COLOUR: the pixels match the ball's colour (orange by default,
       or whatever colour you tapped during setup).
    2. SHAPE:  the blob is roughly round, not a long thin strip.
    3. MOTION: part of the blob changed since the last frame. This is what
       ignores an orange RIM, orange cones or anything else that stands still.

  For speed we shrink every frame to 192 pixels wide before checking it.
  A phone can check ~28,000 pixels many times per second, but not 2 million.
*/

class BallDetector {
  constructor() {
    this.workWidth = 192;    // width of the shrunken frame we analyse
    this.targetHue = 25;     // ball colour as a hue in degrees (0-360). 25 = orange
    this.hueTolerance = 16;  // how far the hue may be from the target
    this.minSaturation = 0.35; // 0 = grey, 1 = strong colour
    this.minBrightness = 0.25; // 0 = black, 1 = bright
    this.requireMotion = true;
    this.prevGray = null;    // the previous frame in black and white, for the motion check
    this.canvas = null;      // created the first time detect() runs
  }

  /*
    Convert a colour from RGB (red, green, blue: 0-255 each) to HSV.
    Returns [hue 0-360, saturation 0-1, value/brightness 0-1].
    HSV is better than RGB for "is this orange?" because shadows change
    brightness a lot but hue only a little.
  */
  static rgbToHsv(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;                 // how "colourful" the pixel is
    const v = max / 255;
    const s = max === 0 ? 0 : d / max;
    let h = 0;                           // let = a variable we will change
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;                           // turn the 0-6 range into degrees
      if (h < 0) h += 360;
    }
    return [h, s, v];
  }

  // Hue is a circle: 350 degrees and 10 degrees are only 20 apart.
  static hueDistance(a, b) {
    const d = Math.abs(a - b);
    return Math.min(d, 360 - d);
  }

  /*
    The core function. Takes raw pixels and returns the ball or null.
    data: array of pixels, 4 numbers each (R, G, B, A), row by row
    w, h: width and height in pixels
    Returns { x, y, r } normalised 0-1, or null.
  */
  detectPixels(data, w, h) {
    const n = w * h;                          // number of pixels
    const mask = new Uint8Array(n);           // 1 = ball-coloured pixel, 0 = not
    const gray = new Uint8Array(n);           // black-and-white copy, for motion
    const moving = new Uint8Array(n);         // 1 = this pixel changed since last frame
    const prev = this.prevGray;

    // Pass 1: look at every pixel once.
    for (let i = 0; i < n; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      gray[i] = (r + g + b) / 3;
      if (prev && Math.abs(gray[i] - prev[i]) > 18) moving[i] = 1;

      const [hue, sat, val] = BallDetector.rgbToHsv(r, g, b);
      if (sat >= this.minSaturation && val >= this.minBrightness &&
          BallDetector.hueDistance(hue, this.targetHue) <= this.hueTolerance) {
        mask[i] = 1;
      }
    }
    this.prevGray = gray;                     // remember this frame for next time

    // Pass 2: group touching ball-coloured pixels into "blobs" (flood fill).
    // labels[i] = which blob pixel i belongs to (0 = none yet).
    const labels = new Int32Array(n);
    const stack = new Int32Array(n);          // pixels waiting to be visited
    let best = null;
    let label = 0;

    for (let start = 0; start < n; start++) {
      if (!mask[start] || labels[start]) continue;   // not ball-coloured, or already in a blob
      label += 1;
      let top = 0;
      stack[top++] = start;
      labels[start] = label;
      // Measurements for this blob:
      let count = 0, sumX = 0, sumY = 0, movingCount = 0;
      let minX = w, maxX = 0, minY = h, maxY = 0;

      while (top > 0) {
        const p = stack[--top];               // take a pixel off the stack
        const x = p % w;                      // % = remainder: column number
        const y = (p - x) / w;                // row number
        count++; sumX += x; sumY += y; movingCount += moving[p];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        // Check the 4 neighbours: left, right, up, down.
        if (x > 0     && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = label; stack[top++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = label; stack[top++] = p + 1; }
        if (y > 0     && mask[p - w] && !labels[p - w]) { labels[p - w] = label; stack[top++] = p - w; }
        if (y < h - 1 && mask[p + w] && !labels[p + w]) { labels[p + w] = label; stack[top++] = p + w; }
      }

      // Check 2: shape. A circle fills about 78% of its bounding box.
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const aspect = bw / bh;                 // 1.0 = as wide as tall
      const fill = count / (bw * bh);
      if (count < 5) continue;                // too tiny: noise
      if (aspect < 0.5 || aspect > 2) continue;
      if (fill < 0.45) continue;
      // Check 3: motion. Need some changed pixels (skipped on the very first frame).
      if (this.requireMotion && prev && movingCount / count < 0.08) continue;

      if (!best || count > best.count) {      // keep the biggest blob that passed
        best = { count, cx: sumX / count, cy: sumY / count, size: Math.max(bw, bh) };
      }
    }

    if (!best) return null;
    return {
      x: (best.cx + 0.5) / w,                 // +0.5 = centre of the pixel
      y: (best.cy + 0.5) / h,
      r: best.size / 2 / w,
    };
  }

  // Browser only: grab the current video frame, shrink it, and detect.
  detect(video) {
    const pixels = this.grab(video);
    if (!pixels) return null;
    return this.detectPixels(pixels.data, pixels.width, pixels.height);
  }

  // Draw the video onto a small hidden canvas and read its pixels.
  grab(video) {
    if (!video.videoWidth) return null;       // camera not ready yet
    const w = this.workWidth;
    const h = Math.round((video.videoHeight / video.videoWidth) * w);
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
      // willReadFrequently tells the browser we will read pixels often (faster).
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    }
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.prevGray = null;                   // size changed: old frame is useless
    }
    this.ctx.drawImage(video, 0, 0, w, h);
    return this.ctx.getImageData(0, 0, w, h);
  }

  /*
    Setup step: the user taps the ball. Read the colour around that point
    (nx, ny normalised) and use its hue as the new target.
    Returns the colour as an "rgb(...)" string so the app can show a swatch,
    or null if the tapped spot isn't colourful enough.
  */
  sampleColour(video, nx, ny) {
    const pixels = this.grab(video);
    if (!pixels) return null;
    const { data, width, height } = pixels;   // "destructuring": pull 3 values out at once
    const cx = Math.round(nx * width);
    const cy = Math.round(ny * height);
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = cy - 2; y <= cy + 2; y++) {  // a 5x5 square around the tap
      for (let x = cx - 2; x <= cx + 2; x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const i = (y * width + x) * 4;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
    }
    if (n === 0) return null;
    r /= n; g /= n; b /= n;                   // average colour
    const [hue, sat] = BallDetector.rgbToHsv(r, g, b);
    if (sat < 0.2) return null;               // too grey to track reliably
    this.targetHue = hue;
    return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
  }
}

if (typeof module !== "undefined") module.exports = { BallDetector };
