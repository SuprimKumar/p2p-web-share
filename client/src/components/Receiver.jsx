import React, { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const SERVER = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";

function formatBytes(b) {
  if (!b) return "";
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  return (b / (1024 * 1024)).toFixed(2) + " MB";
}

export default function Receiver({ roomId, onBack }) {
  const [status, setStatus] = useState("connecting"); // connecting | waiting | receiving | verifying | done | error
  const [fileMeta, setFileMeta] = useState(null);
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState("0.00");
  const [downloadUrl, setDownloadUrl] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");

  const socketRef = useRef(null);
  const pcRef = useRef(null);
  const buffersRef = useRef([]);
  const receivedRef = useRef(0);
  
  // Custom tracking references to counter state closure lags
  const metaRef = useRef(null);
  const startTimeRef = useRef(null);

  useEffect(() => {
    const socket = io(SERVER);
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("join-room", { roomId }, ({ ok, error }) => {
        if (error) {
          setStatus("error");
          setErrorMsg(error === "Room not found" ? "Room not found. The sender may not be ready yet." : error);
          return;
        }
        setStatus("waiting");
      });
    });

    socket.on("signal", async ({ from, data }) => {
      if (!pcRef.current) {
        const pc = createPeerConnection(from, socket);
        pcRef.current = pc;
      }
      const pc = pcRef.current;

      if (data.type === "offer") {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("signal", { to: from, data: { type: "answer", sdp: answer } });
      } else if (data.candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (_) {}
      }
    });

    // FIX 1: Use functional update to check status value safely without stale closure issues
    socket.on("sender-left", () => {
      setStatus((prevStatus) => {
        if (prevStatus !== "done") {
          setErrorMsg("Transfer process terminated: Connection dropped by peer.");
          return "error";
        }
        return prevStatus;
      });
    });

    socket.on("connect_error", () => {
      setStatus("error");
      setErrorMsg("Could not connect to signaling server.");
    });

    return () => {
      socket.disconnect();
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
    };
  }, [roomId]); // FIX 2: Completely removed 'status' from dependencies to stop infinite re-connection loops

  function createPeerConnection(senderId, socket) {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit("signal", { to: senderId, data: { candidate } });
    };

    // FIX 3: Use functional state update here as well to safeguard against dropping verified states
    pc.onconnectionstatechange = () => {
      if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
        setStatus((prevStatus) => {
          if (prevStatus !== "done" && prevStatus !== "error") {
            setErrorMsg("Direct WebRTC connection dropped unexpectedly.");
            return "error";
          }
          return prevStatus;
        });
      }
    };

    pc.ondatachannel = ({ channel }) => {
      setStatus("receiving");
      channel.binaryType = "arraybuffer";

      channel.onmessage = async ({ data }) => {
        // Detect JSON configuration controls
        if (typeof data === "string") {
          try {
            const msg = JSON.parse(data);
            if (msg.type === "meta") {
              metaRef.current = msg;
              setFileMeta({ name: msg.name, size: msg.size, fileType: msg.fileType });
              buffersRef.current = [];
              receivedRef.current = 0;
              startTimeRef.current = performance.now();
            } else if (msg.type === "done") {
              setStatus("verifying");
              
              const meta = metaRef.current;
              const blob = new Blob(buffersRef.current, { type: meta?.fileType || "application/octet-stream" });
              
              // Perform SHA-256 Cryptographic validation checksum checks 
              const completeBuffer = await blob.arrayBuffer();
              const hashBuffer = await crypto.subtle.digest("SHA-256", completeBuffer);
              const hashArray = Array.from(new Uint8Array(hashBuffer));
              const finalGeneratedHash = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

              if (finalGeneratedHash === meta?.hash) {
                const url = URL.createObjectURL(blob);
                setDownloadUrl(url);
                setStatus("done");
                setProgress(100);
                setSpeed("0.00");

                // Automated trigger local file download on validation success 
                const a = document.createElement("a");
                a.href = url;
                a.download = meta.name;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
              } else {
                setStatus("error");
                setErrorMsg("Security Check Alert: Integrated cryptographic verification hash mismatch. Package corrupted.");
              }
            }
          } catch (err) {
            console.error("Control message processing error:", err);
          }
        } else {
          // Processing incoming binary stream array packet blocks
          buffersRef.current.push(data);
          receivedRef.current += data.byteLength;
          
          const meta = metaRef.current;
          if (meta?.size) {
            // Continuous transfer metrics calculation updates 
            const percent = Math.floor((receivedRef.current / meta.size) * 100);
            const elapsedSeconds = (performance.now() - startTimeRef.current) / 1000;
            
            if (elapsedSeconds > 0) {
              const currentSpeedMBs = (receivedRef.current / (1024 * 1024)) / elapsedSeconds;
              setSpeed(currentSpeedMBs.toFixed(2));
            }
            setProgress(percent);
          }
        }
      };

      channel.onerror = (e) => {
        setStatus("error");
        setErrorMsg("Data channel error during transfer.");
      };
    };

    return pc;
  }

  const triggerDownload = () => {
    if (!downloadUrl || !fileMeta) return;
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = fileMeta.name;
    a.click();
  };

  const statusMap = {
    connecting: { dot: "dot-yellow", text: "Connecting to signaling server…" },
    waiting: { dot: "dot-yellow", text: "Connected! Waiting for sender to begin…" },
    receiving: { dot: "dot-blue", text: "Receiving and chunk streaming directly…" },
    verifying: { dot: "dot-yellow", text: "Validating architectural verification hash…" },
    done: { dot: "dot-green", text: "Transfer complete! File auto-downloaded. 🎉" },
    error: { dot: "dot-red", text: errorMsg || "Something went wrong." },
  };

  const s = statusMap[status];

  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <button className="btn btn-ghost back-btn" onClick={onBack} style={{ margin: "0 0 16px 0" }}>
        ← Back
      </button>

      <div className="receive-icon">
        {status === "done" ? "✅" : status === "error" ? "❌" : "📥"}
      </div>

      <h2>Receive File</h2>
      <p className="card-sub">Room: <code style={{ color: "#a5b4fc", fontSize: "0.85rem" }}>{roomId}</code></p>

      <div className="status-row">
        <span className={`dot ${s.dot}`} />
        {s.text}
      </div>

      {fileMeta && (
        <div className="file-chip" style={{ marginBottom: 16 }}>
          <span className="file-icon">📄</span>
          <div className="file-info">
            <div className="file-name">{fileMeta.name}</div>
            <div className="file-size">{formatBytes(fileMeta.size)}</div>
          </div>
        </div>
      )}

      {(status === "receiving" || status === "verifying" || status === "done") && (
        <div className="progress-wrap">
          <div className="progress-label">
            <span>Speed: <strong>{speed} MB/s</strong></span>
            <span>{progress}%</span>
          </div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progress}%`, backgroundColor: status === "done" ? "#48bb78" : "#3182ce" }} />
          </div>
        </div>
      )}

      {status === "done" && downloadUrl && (
        <div className="download-area" style={{ marginTop: 24, padding: 16, background: "#1a202c", borderRadius: 8, textAlign: "center" }}>
          <p style={{ fontSize: "0.88rem", color: "#a0aec0" }}>If your automated native pop-up block intercepted the trigger, click below to re-save manually:</p>
          <button className="btn btn-primary" onClick={triggerDownload} style={{ marginTop: 12, width: "100%" }}>
            ⬇️ Download File
          </button>
        </div>
      )}

      {status === "error" && (
        <p className="err" style={{ color: "#e53e3e", marginTop: 12, fontSize: "0.88rem" }}>{errorMsg}</p>
      )}

      <p className="note">🔒 Decentralized WebRTC channels active — file data streams natively between peers without central storage limits.</p>
    </div>
  );
}