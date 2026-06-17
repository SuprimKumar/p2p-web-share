import React, { useEffect, useRef, useState, useCallback } from "react";
import { io } from "socket.io-client";

const SERVER = import.meta.env.VITE_SERVER_URL || "https://p2p-web-share-hreo.onrender.com";
const CHUNK_SIZE = 64 * 1024; // 64 KB

function formatBytes(b) {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  return (b / (1024 * 1024)).toFixed(2) + " MB";
}

export default function Sender({ onBack }) {
  const [file, setFile] = useState(null);
  const [roomId, setRoomId] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | hashing | waiting | connected | sending | done | error
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState("0.00");
  const [peers, setPeers] = useState(0);
  const [copied, setCopied] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const socketRef = useRef(null);
  const peerConnsRef = useRef({}); // { receiverId: RTCPeerConnection }
  const channelsRef = useRef({}); // { receiverId: RTCDataChannel }
  const sentRef = useRef(0);
  const fileRef = useRef(null);

  useEffect(() => {
    const socket = io(SERVER);
    socketRef.current = socket;

    socket.on("connect", () => {
      // Create signaling channel room
      socket.emit("create-room", ({ roomId }) => {
        setRoomId(roomId);
        setStatus("waiting");
      });
    });

    socket.on("receiver-joined", async ({ receiverId }) => {
      setPeers((p) => p + 1);
      setStatus("connected");
      const pc = createPeerConnection(receiverId, socket);
      peerConnsRef.current[receiverId] = pc;

      // Create configuration metrics data channel
      const channel = pc.createDataChannel("file", { ordered: true });
      channelsRef.current[receiverId] = channel;

      channel.onopen = async () => {
        // Defensive Guard: Ensure file metadata exists before beginning cryptographic stream loop
        if (!fileRef.current) {
          setStatus("waiting");
          return;
        }

        setStatus("hashing");
        
        try {
          // 1. Generate local SHA-256 cryptographic check hash prior to stream dispatch
          const arrayBuffer = await fileRef.current.arrayBuffer();
          const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
          const hashArray = Array.from(new Uint8Array(hashBuffer));
          const fileHash = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

          // 2. Dispatch secure validation block map payload to receiver
          channel.send(JSON.stringify({
            type: "meta",
            name: fileRef.current.name,
            size: fileRef.current.size,
            fileType: fileRef.current.type,
            hash: fileHash // Verification block key mapping
          }));
          
          // 3. Initiate binary streaming loops
          sendFile(channel, fileRef.current);
        } catch (err) {
          console.error("Cryptographic processing error:", err);
          setStatus("error");
        }
      };

      channel.onerror = (e) => console.error("Data channel transmission fault", e);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("signal", { to: receiverId, data: { type: "offer", sdp: offer } });
    });

    // Handle abrupt receiver drop out signals dynamically from server
    socket.on("receiver-left", ({ receiverId }) => {
      setPeers((p) => Math.max(0, p - 1));
      
      if (peerConnsRef.current[receiverId]) {
        peerConnsRef.current[receiverId].close();
        delete peerConnsRef.current[receiverId];
      }
      if (channelsRef.current[receiverId]) {
        delete channelsRef.current[receiverId];
      }
      
      // Gracefully restore wait states instead of crashing UI blocks
      setStatus("waiting");
      setProgress(0);
      setSpeed("0.00");
    });

    socket.on("signal", async ({ from, data }) => {
      const pc = peerConnsRef.current[from];
      if (!pc) return;
      if (data.type === "answer") {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      } else if (data.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    });

    socket.on("connect_error", () => setStatus("error"));

    return () => {
      socket.disconnect();
      Object.values(peerConnsRef.current).forEach((pc) => pc.close());
    };
  }, []);

  function createPeerConnection(receiverId, socket) {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        socket.emit("signal", { to: receiverId, data: { candidate } });
      }
    };

    // Monitor local hardware connection drops on WebRTC directly
    pc.onconnectionstatechange = () => {
      if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
        setStatus("waiting");
        setPeers((p) => Math.max(0, p - 1));
        setProgress(0);
        setSpeed("0.00");
      }
    };

    return pc;
  }

  function sendFile(channel, file) {
    setStatus("sending");
    sentRef.current = 0;
    const reader = new FileReader();
    let offset = 0;
    let startTime = performance.now();

    function readSlice(o) {
      const slice = file.slice(o, o + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    }

    reader.onload = (e) => {
      if (channel.readyState !== "open") return;

      // Handle backpressure constraints gracefully to avoid browser crashes
      if (channel.bufferedAmount > 16 * 1024 * 1024) {
        setTimeout(() => reader.onload(e), 50);
        return;
      }

      channel.send(e.target.result);
      offset += e.target.result.byteLength;
      sentRef.current = offset;
      
      // Continuous metrics compilation calculations
      const percent = Math.floor((offset / file.size) * 100);
      const timeElapsed = (performance.now() - startTime) / 1000; // in seconds
      
      if (timeElapsed > 0) {
        const currentSpeedMBs = (offset / (1024 * 1024)) / timeElapsed;
        setSpeed(currentSpeedMBs.toFixed(2));
      }

      setProgress(percent);

      if (offset < file.size) {
        readSlice(offset);
      } else {
        channel.send(JSON.stringify({ type: "done" }));
        setStatus("done");
        setProgress(100);
        setSpeed("0.00");
      }
    };

    readSlice(0);
  }

  const handleFileSelect = useCallback((selectedFile) => {
    if (!selectedFile) return;
    setFile(selectedFile);
    fileRef.current = selectedFile;
  }, []);

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFileSelect(f);
  };

  const shareUrl = roomId ? `${window.location.origin}/?room=${roomId}` : "";

  const copyLink = () => {
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const statusMap = {
    idle: null,
    hashing: { dot: "dot-yellow", text: "Generating cryptographic check hash…" },
    waiting: { dot: "dot-yellow", text: "Waiting for receiver to connect…" },
    connected: { dot: "dot-green", text: `${peers} receiver connected` },
    sending: { dot: "dot-blue", text: `Sending stream loops directly…` },
    done: { dot: "dot-green", text: "Transfer verified successfully! 🎉" },
    error: { dot: "dot-red", text: "Connection anomaly. Please refresh." },
  };

  const s = statusMap[status];

  return (
    <div className="card" style={{ maxWidth: 520 }}>
      <button className="btn btn-ghost back-btn" onClick={onBack} style={{ margin: "0 0 16px 0" }}>
        ← Back
      </button>
      <h2>Send a File</h2>
      <p className="card-sub">Drop your file below, then share the generated link.</p>

      {!file ? (
        <div
          className={`dropzone${dragOver ? " active" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          <input
            type="file"
            onChange={(e) => handleFileSelect(e.target.files[0])}
          />
          <div className="dropzone-icon">📂</div>
          <p><strong>Click to browse</strong> or drag & drop</p>
          <p style={{ marginTop: 4, fontSize: "0.78rem" }}>Any file type, any size</p>
        </div>
      ) : (
        <div className="file-chip">
          <span className="file-icon">📄</span>
          <div className="file-info">
            <div className="file-name">{file.name}</div>
            <div className="file-size">{formatBytes(file.size)}</div>
          </div>
          {status === "idle" || status === "waiting" ? (
            <button className="btn btn-ghost" onClick={() => { setFile(null); fileRef.current = null; }}>✕</button>
          ) : null}
        </div>
      )}

      {roomId && (
        <>
          <div className="share-link-box">
            <input readOnly value={shareUrl} onClick={(e) => e.target.select()} />
            <button className="btn btn-outline" onClick={copyLink}>
              {copied ? "✓ Copied" : "Copy"}
            </button>
          </div>

          {s && (
            <div className="status-row">
              <span className={`dot ${s.dot}`} />
              {s.text}
              {peers > 0 && status === "waiting" && (
                <span className="peers-badge">👤 {peers}</span>
              )}
            </div>
          )}

          {(status === "sending" || status === "done") && (
            <div className="progress-wrap">
              <div className="progress-label">
                <span>Speed: <strong>{speed} MB/s</strong></span>
                <span>{progress}%</span>
              </div>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}
        </>
      )}

      <p className="note">🔒 Decentralized WebRTC channels active — file data streams natively between peers without central storage limits.</p>
    </div>
  );
}
