# Shot Tracker

A phone web app that watches you shoot through the phone's camera and counts your
makes, misses and shooting percentage live. No app store, no server: it runs in the
phone's browser.

## How it works

```
phone camera (live)
  -> js/ballDetector.js   finds the ball: right colour + round shape + moving
  -> js/shotDetector.js   ball rises above the rim, then comes down past it:
                          crossed inside the rim = MAKE, outside = MISS
  -> js/session.js        keeps the score
  -> js/app.js            screens, buttons, drawing, the main loop
```

The motion check is what stops an orange rim, cones or other still objects from
being mistaken for the ball.

## Files

| File | What it does |
|---|---|
| `index.html` | What's on screen: camera view, scoreboard, setup panel, buttons |
| `style.css` | How it looks |
| `js/session.js` | Score keeping: record, undo, flip, percentage |
| `js/ballDetector.js` | Finds the ball in each camera frame |
| `js/shotDetector.js` | Decides make or miss from the ball's path |
| `js/app.js` | Runs everything: setup steps, main loop, drawing, history |

## Put it on your phone (free, with GitHub Pages)

The camera only works on `https://` pages, and GitHub Pages gives you one for free.

1. On github.com, click **New repository**, name it `shot-tracker`, make it **Public**, click **Create**.
2. In VS Code's terminal, inside this folder:
   ```
   git init
   git add .
   git commit -m "Shot tracker phone app"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/shot-tracker.git
   git push -u origin main
   ```
3. On the repository page: **Settings**, then **Pages**. Under "Branch" pick `main` and `/ (root)`, then **Save**.
4. Wait 1-2 minutes. Your app is at `https://YOUR-USERNAME.github.io/shot-tracker/`.
5. Open that link on your phone and allow camera access. In Chrome or Safari use
   "Add to Home screen" so it opens like an app.

After any change: `git add .`, `git commit -m "..."`, `git push`, and the site updates in a minute.

## Test on your laptop first

```
python -m http.server 8000
```
Then open `http://localhost:8000` in Chrome. It uses your webcam (localhost is allowed).

## At the court

1. Put the phone at the side of the court, steady (a small tripod or lean it on your bag),
   so it sees you **and** the air above the hoop. Landscape works best.
2. **Start camera**, then drag a tight box around the rim.
3. Hold the ball up and tap it on screen (or Skip to use plain orange).
4. **Start tracking** and shoot. The phone beeps high for a make, low for a miss.
5. **Undo** / **Flip last** fix mistakes. **+ Make** / **+ Miss** add a shot by hand.
6. **End** saves the session; your last 10 sessions are shown.

## Limits to know

- Shots must go higher than the rim to count.
- The phone must not move after you mark the rim.
- Bright sun, deep shadow, or someone in an orange shirt moving near the hoop can confuse it.
- A ball that bounces high off the rim and drops in later may be judged wrong: use Flip.
- Sessions are stored on that phone's browser only.
