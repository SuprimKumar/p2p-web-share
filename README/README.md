# P2P Web Share — Direct Browser-to-Browser File Transfer

A lightweight, decentralized P2P file sharing web app. Drop a file → get a share link → the recipient downloads directly from your browser via WebRTC. The signaling server never sees file data.

## Tech Stack
- **Frontend**: React.js + Vite
- **Backend (Signaling)**: Node.js + Express + Socket.IO
- **P2P Transfer**: WebRTC Data Channels

## Setup

### 1. Install server dependencies
```bash
cd server
npm install
```

### 2. Install client dependencies
```bash
cd client
npm install
```

### 3. Run the server
```bash
cd server
npm run dev
```

### 4. Run the client (new terminal)
```bash
cd client
npm run dev
```

Open `http://localhost:3000`.

## How It Works
1. Sender drops a file → server creates a room → a shareable link is generated.
2. Receiver opens the link → both peers exchange WebRTC offer/answer via the signaling server.
3. A direct data channel opens → file chunks stream P2P at 64 KB each.
4. Server is only used for the initial handshake — never for file data.

## Deploy
- **Server**: Render / Railway — set `PORT` env var
- **Client**: Vercel / Netlify — set `VITE_SERVER_URL=https://your-server-url`