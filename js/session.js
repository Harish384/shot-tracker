/*
  session.js - keeps the score for ONE shooting session.
  (Same idea as session.py in the Python version, now in JavaScript.)

  JavaScript notes for Python people:
  - Python "def" is "function" or a method inside a class.
  - "self" in Python is "this" in JavaScript.
  - Every statement can end with a semicolon ;
  - Blocks use { curly braces } instead of indentation.
*/

class Session {
  // constructor = Python's __init__. Runs when you write: new Session()
  constructor() {
    this.made = 0;              // number of made shots
    this.attempted = 0;         // number of shots taken
    this.history = [];          // ["make", "miss", ...] in order
    this.startedAt = new Date(); // the date and time right now
  }

  // Add one shot. made is true for a make, false for a miss.
  record(made) {
    this.attempted += 1;
    if (made) {
      this.made += 1;
    }
    // "condition ? a : b" means: if condition then a, else b
    this.history.push(made ? "make" : "miss");  // push = Python's append
  }

  // Remove the last shot.
  undo() {
    if (this.history.length === 0) return;      // === means "exactly equal"
    const last = this.history.pop();            // const = a variable that won't be reassigned
    this.attempted -= 1;
    if (last === "make") this.made -= 1;
  }

  // Change the last shot from make to miss or miss to make.
  flipLast() {
    const i = this.history.length - 1;          // index of the last item
    if (i < 0) return;
    if (this.history[i] === "make") {
      this.history[i] = "miss";
      this.made -= 1;
    } else {
      this.history[i] = "make";
      this.made += 1;
    }
  }

  // "get" makes this work like a variable: session.percentage (no brackets).
  get percentage() {
    if (this.attempted === 0) return 0;         // avoid dividing by zero
    return (this.made / this.attempted) * 100;
  }

  // Turn the session into a plain object we can save.
  toRecord() {
    return {
      date: this.startedAt.toISOString(),       // e.g. "2026-10-09T05:58:00.000Z"
      made: this.made,
      attempted: this.attempted,
    };
  }
}

// Lets our Node.js test file load this class. In the browser "module" doesn't exist,
// so this line is skipped there.
if (typeof module !== "undefined") module.exports = { Session };
