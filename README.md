# Duel Wordle

A real-time, head-to-head multiplayer Wordle you can host yourself. Two (or more)
players open the site in their own browser, join the same room code, and race to
guess the same secret word.

## Features

- Word length 5–8 letters (configurable per room)
- Attempts = letters + 1 by default (5→6, 6→7, 7→8, 8→9), but fully
  overridable per room (2–20 attempts)
- Multi-round sessions: set how many rounds to play in a row (1–20). Everyone
  must finish the current round (solve or run out of attempts) before the
  host can advance to the next one; scores accumulate across rounds and the
  final screen ranks players by their running total
- Scoring: guessing on attempt *k* scores `(maxAttempts - k) + 1` points
  (earlier = more points; not solving = 0 points)
- English / French dictionaries, switchable in the settings menu
- Guesses only need to be the right length and made of letters — they are
  **not** checked against the dictionary, so any letter combination is a
  valid guess (the secret word itself is still picked from the real
  dictionary for the chosen language/length)
- Optional per-row timer (default 10s, configurable 5–120s) — if you don't submit
  a full row in time, it's skipped and you move to the next attempt
- True multiplayer: a Node.js + Socket.IO server holds the room state, so any
  number of browsers/devices can connect and compete at once
- Opponents' progress is shown live as colored dots only (not letters), so it
  stays a fair race
- Host can stop the game at any point (mid-round or between rounds) and send
  everyone straight back to the lobby with a confirmation prompt first

## Project structure

```
wordle/
  server.js          # Express + Socket.IO game server (rooms, scoring, validation)
  package.json
  data/
    words.json        # {en:{5:[...],6:[...],7:[...],8:[...]}, fr:{...}} dictionaries
  public/
    index.html
    style.css
    client.js          # all client game logic (boards, keyboard, timer, sockets)
```

## Run it locally

Requires Node.js 18+.

```bash
cd wordle
npm install
npm start
```

Then open `http://localhost:3000` in two different browser windows (or have a
friend on the same network open `http://<your-computer-ip>:3000`) to play against
each other.

> Note: I wasn't able to run `npm install` in this sandbox (no outbound network
> access here), so the dependency install itself is untested in this environment
> — but the code was syntax-checked and the core matching/scoring algorithm was
> unit-tested by hand (including duplicate-letter edge cases like GUESS="plate"
> vs SECRET="apple"). Run it locally first to confirm everything behaves as
> expected before you rely on it for a real match.

## How to play

1. Enter your name, click **Create Room** — you become the host and get a 5
   character room code.
2. Send the code to a friend; they enter it under **Join**.
3. The host picks word length, language, and timer settings in the lobby, then
   hits **Start Game**.
4. Everyone gets their own board with the *same* secret word and races to solve
   it — type or use the on-screen keyboard, Enter to submit.
5. When everyone has finished (solved or run out of attempts), the word is
   revealed and scores are shown. The host can hit **Rematch** to play again
   with the same settings.

## Known limitations / things to tighten up if you extend this

- Rooms live only in server memory — restarting the server clears all games.
  Fine for casual play; add Redis or a DB if you need persistence.
- The word lists are built from public frequency lists (Google's 10k English
  words, a French lemma frequency list), filtered to 5–8 letters, with two
  extra cleanup passes:
  - **Accents are folded** — the French list is stored with diacritics
    stripped (`é/è/ê→e`, `à/â→a`, `ç→c`, etc.), so accents never matter for
    matching. This also means the game only ever needs a plain A–Z keyboard.
  - **Conjugated verbs are filtered out** — English words ending in `-ing`/
    `-ed` are dropped when they match a common verb root (`walking`,
    `talked`, `building` → removed), keeping base/infinitive forms and
    standalone nouns (`morning`, `wedding`, `spring`, `sterling` stay). This
    is a heuristic against a ~250-word list of common verb roots, not a real
    lemmatizer, so it isn't perfect — a genuinely obscure conjugated form
    could still slip through, or in rare cases a legitimate word could be
    caught if it happens to share a root with a common verb. The French list
    was already delivered pre-lemmatized by its source and was spot-checked
    to confirm it doesn't contain conjugated forms.
  They're solid for a casual game but not a fully curated dictionary — a
  handful of proper nouns or odd forms may still slip through as possible
  *secret* words (guesses themselves aren't checked against the dictionary at
  all — see below). Swap in `data/words.json` (same shape:
  `{en:{5:[...],...}, fr:{...}}`) with a more official list (e.g. Scrabble
  dictionaries) if you want a cleaner pool of secret words.
- Guesses aren't checked against the dictionary — this is intentional (see
  Features above), but it does mean there's nothing stopping a player from
  guessing random letter combinations to "probe" the secret word's letters
  without needing to know a real word. If you'd rather bring dictionary
  validation back, the change is a couple of lines in `server.js`'s
  `submit_guess` handler.
- No authentication/anti-cheat — anyone with the room code can join.

## Free hosting options

This app needs a **persistent server process with WebSocket support**, which
rules out pure static hosts (GitHub Pages, Netlify's static tier) and
serverless-function platforms that don't keep a socket connection open. Good
free-tier options that do support this:

| Host | Free tier notes |
|---|---|
| **Render.com** | Free "Web Service" tier runs a Node process and supports WebSockets. It spins down after ~15 minutes idle and takes 30–60s to wake back up on the next request — fine for casual games with friends. Easiest path: push this folder to a GitHub repo, connect it on Render, set build command `npm install` and start command `npm start`. |
| **Fly.io** | Free allowance (small shared-CPU VM) that runs a real always-on container, so no cold-start sleep like Render's free tier. Deploy with the `fly` CLI (`fly launch`, `fly deploy`); it auto-detects Node apps. |
| **Glitch.com** | Import the project (or paste the files in), it runs Node + WebSockets out of the box, good for quick demos; free projects sleep after inactivity and have modest resource limits. |
| **Railway.app** | Has a small free/trial credit rather than an indefinite free tier now, but is very easy to deploy to (`railway up`) if you're fine using the trial credit or a few dollars/month. |

For casual play with a friend, **Render.com's free web service** is probably
the best balance of "actually free" and "zero DevOps" — just be aware of the
cold-start delay if nobody's used it in the last 15 minutes.

Whichever host you pick, the two things to check in their dashboard are: (1) it
runs a persistent Node process (not "static site" or "serverless function"),
and (2) it supports WebSockets on the free tier — both Render and Fly.io do.
