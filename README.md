# Treasure Hunt — Multiplayer Island Dash

A real-time 2–6 player browser game. The Node.js server owns movement, treasure collection, scoring, and the two-minute match timer. Browsers connect through Socket.IO.

## Requirements
- Node.js 18 or newer
- npm
- A browser (desktop or phone)

## Run locally
1. Extract this folder.
2. In a terminal, change into the `treasure_hunt` folder.
3. Run:
   ```bash
   npm install
   npm start
   ```
4. Open http://localhost:3000.

To test with another device on the same Wi-Fi, open `http://YOUR_COMPUTER_LAN_IP:3000` on that device. Allow the port through your local firewall if needed. This local-LAN method is not a public internet link.

## Play
1. Enter a name and choose a character.
2. Create an island. The URL gets a room code.
3. Use **Copy invite link** and send the link to friends.
4. Friends open the link and join the lobby. The host can start once at least two players are present.
5. Move with WASD or arrow keys. On phones, hold the on-screen direction buttons.
6. Common chests award 10 points; rare chests award 25. Highest score at 00:00 wins.

## Public deployment
A public link requires hosting for the Node server; a static-site host alone is not enough. Use a Node-compatible host such as Render, Railway, Fly.io, or a VPS.

General deployment steps:
1. Push the project to a Git repository.
2. Create a **web service** from that repository on a Node-compatible host.
3. Build command: `npm install`
4. Start command: `npm start`
5. Ensure the host provides the `PORT` environment variable (the app uses it automatically).
6. Open the service's HTTPS URL and create a room. Share the invite URL.

The app uses Socket.IO WebSockets with polling fallback. Make sure the host supports long-lived WebSocket connections. For a single server instance, room state is kept in memory. If you scale to multiple instances, add a shared Socket.IO adapter (for example Redis) and a shared authoritative room-state strategy; otherwise players routed to different instances will not share the same rooms. The host must keep the service running for rooms to remain available.

Optional environment variable:
- `ALLOWED_ORIGIN`: restrict allowed origins for Socket.IO. Leave unset for the simple default; configure it to the public app origin for a production deployment.

## Project layout
- `server.js` — Express server, Socket.IO events, authoritative simulation, room and timer logic
- `public/index.html` — responsive UI, Canvas island map, keyboard/touch controls
- `package.json` — dependencies and start script

## Current implementation notes
- Rooms are process-memory only and disappear when the server restarts or the room empties.
- The server controls movement and validates collection range; treasure is marked collected before score award/broadcast, preventing duplicate scoring under simultaneous collection.
- Match end time is server-owned. The browser estimates server-clock offset using a periodic Socket.IO round-trip time-sync event and displays the countdown against the shared end timestamp; it falls back to the server timestamp in room state until the first sync response.
- A disconnected socket is removed from the room; if the host leaves, host controls pass to another player.
- Joining is lobby-only, and room capacity is six.
- For a production release, add rate limits, robust reconnect identity tokens, input throttling, structured logging, and load testing.
