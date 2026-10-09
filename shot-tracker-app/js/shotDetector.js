/*
  shotDetector.js - decides "make" or "miss" from the ball's path.

  All positions are NORMALISED: x and y go from 0 to 1 across the camera picture,
  so the code works the same on any phone, whatever its camera resolution.
  y = 0 is the TOP of the picture, y = 1 the bottom. "Above the hoop" = smaller y.

  The rule:
    1. Ball goes ABOVE the hoop and near it sideways  -> a shot is in the air.
    2. Ball comes back DOWN past the rim's height.
    3. Work out where it crossed: inside the rim = MAKE, outside = MISS.
    4. Ball disappears for too long = MISS.
    5. Short cooldown so one shot isn't counted twice.

  We use TIME (milliseconds) instead of frame numbers, because phones process
  a different number of frames per second depending on how busy they are.
*/

class ShotDetector {
  // hoop = { x, y, w, h } normalised box the user drew around the rim.
  // The "= {}" and the names inside { } are default settings you can override.
  constructor(hoop, {
    zoneWidthFactor = 3,    // how many rim-widths left/right count as "near the hoop"
    maxGapMs = 600,         // longest the ball may vanish while crossing the rim
    timeoutMs = 2500,       // give up on a shot after this long
    cooldownMs = 800,       // ignore the ball this long after deciding
  } = {}) {
    this.hoop = hoop;
    this.zoneWidthFactor = zoneWidthFactor;
    this.maxGapMs = maxGapMs;
    this.timeoutMs = timeoutMs;
    this.cooldownMs = cooldownMs;

    this.state = "idle";      // "idle" = waiting for a shot, "inAir" = shot happening
    this.lastAbove = null;    // { t, x, y } last time we saw the ball above the rim
    this.shotStart = 0;       // when the current shot was first seen
    this.cooldownUntil = 0;   // time when the cooldown ends
  }

  // The rim's height: the middle of the box the user drew.
  get rimY() {
    return this.hoop.y + this.hoop.h / 2;
  }

  nearHoopSideways(x) {
    const margin = this.hoop.w * this.zoneWidthFactor;
    return x >= this.hoop.x - margin && x <= this.hoop.x + this.hoop.w + margin;
  }

  finish(result, now) {
    this.state = "idle";
    this.lastAbove = null;
    this.cooldownUntil = now + this.cooldownMs;
    return result;
  }

  /*
    Call once per processed frame.
    now:  current time in milliseconds
    ball: { x, y } or null if no ball was found
    Returns "make", "miss" or null.
  */
  update(now, ball) {
    // Step 5: cooldown.
    if (now < this.cooldownUntil) return null;

    // Step 1: waiting for a shot.
    if (this.state === "idle") {
      if (ball && ball.y < this.hoop.y && this.nearHoopSideways(ball.x)) {
        this.state = "inAir";
        this.lastAbove = { t: now, x: ball.x, y: ball.y };
        this.shotStart = now;
      }
      return null;
    }

    // From here: a shot is in the air.
    if (now - this.shotStart > this.timeoutMs) return this.finish("miss", now);  // Step 4
    if (!ball) return null;  // not visible this frame, it may come back

    // Still above the rim line: remember the newest position.
    if (ball.y < this.rimY) {
      this.lastAbove = { t: now, x: ball.x, y: ball.y };
      return null;
    }

    // Step 2: the ball has come down past the rim line.
    const a = this.lastAbove;
    if (now - a.t > this.maxGapMs) return this.finish("miss", now);  // lost too long to judge

    // Step 3: linear interpolation. The ball moved in a near-straight line from
    // point a (above) to ball (below). t = how far along that line the rim height is.
    const t = (this.rimY - a.y) / (ball.y - a.y);
    const crossX = a.x + t * (ball.x - a.x);
    const inside = crossX >= this.hoop.x && crossX <= this.hoop.x + this.hoop.w;
    return this.finish(inside ? "make" : "miss", now);
  }
}

if (typeof module !== "undefined") module.exports = { ShotDetector };
