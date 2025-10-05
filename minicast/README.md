MiniCast — simple Twitch-like prototype (Firebase + WebRTC)

Overview
- Lightweight prototype showing how to wire broadcaster/viewer flows using Firebase as signaling and Realtime Database for chat.

Files
- `index.html` — UI and SDK imports.
- `styles.css` — basic styling.
- `app.js` — main logic (auth, simple chat, media capture). Signaling/peer connections are stubbed for later tasks.

Setup
1. Create a Firebase project at https://console.firebase.google.com
2. Enable Authentication (Email/Password) and Realtime Database.
3. Copy your Firebase config into `app.js` replacing the placeholder `firebaseConfig` object.
4. Serve the folder (e.g., use a static server or VS Code Live Server) and open `index.html`.

Next steps
- Implement full WebRTC offer/answer flow for broadcaster and viewer using the Realtime Database as the signaling channel.
- Add per-viewer peer connections for scalability or integrate a media server for larger audiences.
