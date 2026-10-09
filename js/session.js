/*
  session.js (version 3) - keeps the score for ONE shooting session,
  now including WHICH SPOT each shot was taken from (for the shot chart).

  Each shot in history is an object: { result: "make" or "miss", spot: "lw" }
*/

class Session {
  constructor() {
    this.made = 0;
    this.attempted = 0;
    this.history = [];             // every shot in order
    this.startedAt = new Date();   // when the session started
    this.endedAt = null;           // set when you press End
  }

  // Add one shot. made: true/false. spot: the spot's id, e.g. "lw" (left wing).
  record(made, spot = "mixed") {
    this.attempted += 1;
    if (made) this.made += 1;
    this.history.push({ result: made ? "make" : "miss", spot });
  }

  // Remove the last shot.
  undo() {
    if (this.history.length === 0) return;
    const last = this.history.pop();
    this.attempted -= 1;
    if (last.result === "make") this.made -= 1;
  }

  // Change the last shot from make to miss or the other way round.
  flipLast() {
    const last = this.history[this.history.length - 1];
    if (!last) return;
    if (last.result === "make") {
      last.result = "miss";
      this.made -= 1;
    } else {
      last.result = "make";
      this.made += 1;
    }
  }

  get percentage() {
    if (this.attempted === 0) return 0;
    return (this.made / this.attempted) * 100;
  }

  /*
    Count makes and attempts per spot.
    Returns an object like: { lw: { made: 3, att: 5 }, top: { made: 1, att: 4 } }
  */
  spotStats() {
    const stats = {};
    for (const shot of this.history) {
      // If this spot has no entry yet, create one: "||" means "or, if missing, ..."
      const s = stats[shot.spot] || (stats[shot.spot] = { made: 0, att: 0 });
      s.att += 1;
      if (shot.result === "make") s.made += 1;
    }
    return stats;
  }

  end() {
    this.endedAt = new Date();
  }

  // A plain object we can save in the phone's storage and show as a report.
  toRecord() {
    return {
      date: this.startedAt.toISOString(),                 // start time
      end: (this.endedAt || new Date()).toISOString(),    // end time
      made: this.made,
      attempted: this.attempted,
      spots: this.spotStats(),
    };
  }
}

if (typeof module !== "undefined") module.exports = { Session };
