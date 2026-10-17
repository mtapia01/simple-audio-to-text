# Lecture Transcriber

Turns lecture recordings into text. Whisper runs inside the browser, so there is no server and audio never leaves the computer.

## Files
| File | What it does |
|---|---|
| `index.html` | Page markup. The model dropdown options live here. |
| `style.css` | All styling. Colors are variables at the top. |
| `app.js` | File list, transcription queue, audio player, live captions, export. |
| `worker.js` | Loads Whisper and transcribes in 30-second windows (change `WIN` to adjust). |

## Run locally
Open a terminal in this folder and run `python -m http.server 8000`, then visit http://localhost:8000.
(Opening `index.html` by double-clicking will not work: browsers block workers and modules on `file://`.)

## Deploy on GitHub Pages
Upload all files in this folder to the repo root, then Settings > Pages > deploy from the `main` branch.