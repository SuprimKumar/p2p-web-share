import React, { useState, useEffect } from "react";
import Sender from "./components/Sender.jsx";
import Receiver from "./components/Receiver.jsx";

function getPageMode() {
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get("room");
  if (roomId) return { mode: "receive", roomId };
  return { mode: "home" };
}

export default function App() {
  const [page, setPage] = useState(getPageMode);

  useEffect(() => {
    const onPop = () => setPage(getPageMode());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const goHome = () => {
    window.history.pushState({}, "", "/");
    setPage({ mode: "home" });
  };

  const goSend = () => {
    window.history.pushState({}, "", "/");
    setPage({ mode: "send" });
  };

  return (
    <div id="root">
      <header className="app-header">
        <div className="logo-icon">⚡</div>
        <h1>P2P Web Share</h1>
      </header>

      <main className="app-main">
        {page.mode === "home" && (
          <>
            <div className="home-title">
              <h2>Share files, directly.</h2>
              <p>Browser-to-browser transfers. No uploads, no servers storing your data.</p>
            </div>
            <div className="home-actions">
              <button className="btn btn-primary" onClick={goSend}>
                📤 Send a File
              </button>
              <button className="btn btn-outline" onClick={() => {
                const id = prompt("Enter room ID or paste the full share link:");
                if (!id) return;
                const roomId = id.includes("room=") ? new URL(id).searchParams.get("room") : id.trim();
                window.history.pushState({}, "", `/?room=${roomId}`);
                setPage({ mode: "receive", roomId });
              }}>
                📥 Receive a File
              </button>
            </div>
          </>
        )}

        {page.mode === "send" && <Sender onBack={goHome} />}
        {page.mode === "receive" && <Receiver roomId={page.roomId} onBack={goHome} />}
      </main>
    </div>
  );
}