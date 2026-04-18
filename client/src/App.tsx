import { useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { CHUNK_SIZE, RTC_CONFIG, waitForBufferedAmountLow } from "./lib/webrtc";
import { formatBytes, generateRoomCode } from "./lib/format";

type ConnectionStatus = "Disconnected" | "Waiting" | "Connected";
type TransferState = "idle" | "sending" | "receiving" | "completed" | "cancelled" | "error";

type ControlMessage =
  | {
      type: "file-meta";
      transferId: string;
      name: string;
      size: number;
      chunkSize: number;
      totalChunks: number;
    }
  | { type: "file-end"; transferId: string }
  | { type: "cancel-transfer"; transferId?: string }
  | { type: "ping"; ts: number }
  | { type: "pong"; ts: number };

interface IncomingFile {
  transferId: string;
  name: string;
  size: number;
  chunkSize: number;
  totalChunks: number;
}

interface SignalingAck {
  ok: boolean;
  roomId?: string;
  hostId?: string;
  message?: string;
}

const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || "http://localhost:4000";

function App() {
  const socketRef = useRef<Socket | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const remoteSocketIdRef = useRef<string | null>(null);
  const incomingFileRef = useRef<IncomingFile | null>(null);
  const receivedChunksRef = useRef<ArrayBuffer[]>([]);
  const receivedBytesRef = useRef(0);
  const activeOutgoingTransferIdRef = useRef<string | null>(null);
  const cancelTransferRef = useRef(false);
  const pingIntervalRef = useRef<number | null>(null);
  const currentRoomIdRef = useRef("");
  const serverConnectedRef = useRef(false);

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("Disconnected");
  const [serverConnected, setServerConnected] = useState(false);
  const [currentRoomId, setCurrentRoomId] = useState("");
  const [roomInput, setRoomInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [isHost, setIsHost] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [infoMessage, setInfoMessage] = useState("Create a room or join one to start.");

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [uploadMeta, setUploadMeta] = useState("");
  const [downloadMeta, setDownloadMeta] = useState("");
  const [transferState, setTransferState] = useState<TransferState>("idle");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  const isChannelOpen = dataChannelRef.current?.readyState === "open";

  const canSendFile = useMemo(
    () => Boolean(selectedFile && isChannelOpen && transferState !== "sending"),
    [selectedFile, isChannelOpen, transferState],
  );

  function clearPingLoop() {
    if (pingIntervalRef.current !== null) {
      window.clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
  }

  function startPingLoop() {
    clearPingLoop();

    pingIntervalRef.current = window.setInterval(() => {
      const channel = dataChannelRef.current;
      if (!channel || channel.readyState !== "open") return;

      const payload: ControlMessage = { type: "ping", ts: Date.now() };
      channel.send(JSON.stringify(payload));
    }, 4000);
  }

  function resetIncomingTransfer() {
    incomingFileRef.current = null;
    receivedChunksRef.current = [];
    receivedBytesRef.current = 0;
    setDownloadProgress(0);
    setDownloadMeta("");
  }

  function resetOutgoingTransfer() {
    activeOutgoingTransferIdRef.current = null;
    cancelTransferRef.current = false;
    setUploadProgress(0);
    setUploadMeta("");
  }

  function closePeerConnection() {
    dataChannelRef.current?.close();
    dataChannelRef.current = null;

    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;

    remoteSocketIdRef.current = null;
    setConnectionStatus(serverConnectedRef.current && currentRoomIdRef.current ? "Waiting" : "Disconnected");
    setLatencyMs(null);
    clearPingLoop();
  }

  function sendControlMessage(message: ControlMessage) {
    const channel = dataChannelRef.current;
    if (!channel || channel.readyState !== "open") return;
    channel.send(JSON.stringify(message));
  }

  function triggerDownload(name: string, chunks: ArrayBuffer[]) {
    const fileBlob = new Blob(chunks);
    const objectUrl = URL.createObjectURL(fileBlob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
  }

  async function handleDataMessage(rawData: string | ArrayBuffer | Blob) {
    if (typeof rawData === "string") {
      let control: ControlMessage;
      try {
        control = JSON.parse(rawData) as ControlMessage;
      } catch {
        return;
      }

      if (control.type === "ping") {
        sendControlMessage({ type: "pong", ts: control.ts });
        return;
      }

      if (control.type === "pong") {
        setLatencyMs(Math.max(1, Date.now() - control.ts));
        return;
      }

      if (control.type === "cancel-transfer") {
        resetIncomingTransfer();
        setTransferState("cancelled");
        setInfoMessage("Transfer cancelled by peer.");
        return;
      }

      if (control.type === "file-meta") {
        incomingFileRef.current = {
          transferId: control.transferId,
          name: control.name,
          size: control.size,
          chunkSize: control.chunkSize,
          totalChunks: control.totalChunks,
        };

        receivedChunksRef.current = [];
        receivedBytesRef.current = 0;
        setTransferState("receiving");
        setDownloadProgress(0);
        setDownloadMeta(`${control.name} (${formatBytes(control.size)})`);
        return;
      }

      if (control.type === "file-end") {
        const fileMeta = incomingFileRef.current;
        if (!fileMeta || fileMeta.transferId !== control.transferId) {
          return;
        }

        triggerDownload(fileMeta.name, receivedChunksRef.current);
        setDownloadProgress(100);
        setTransferState("completed");
        setInfoMessage(`Download complete: ${fileMeta.name}`);
        resetIncomingTransfer();
      }

      return;
    }

    const chunkBuffer = rawData instanceof Blob ? await rawData.arrayBuffer() : rawData;
    const fileMeta = incomingFileRef.current;
    if (!fileMeta) return;

    receivedChunksRef.current.push(chunkBuffer);
    receivedBytesRef.current += chunkBuffer.byteLength;

    const nextProgress = Math.min(100, (receivedBytesRef.current / fileMeta.size) * 100);
    setDownloadProgress(nextProgress);
  }

  function setupDataChannel(channel: RTCDataChannel) {
    dataChannelRef.current = channel;
    channel.binaryType = "arraybuffer";

    channel.onopen = () => {
      setConnectionStatus("Connected");
      setErrorMessage("");
      setInfoMessage("Peer connection is ready. You can transfer files now.");
      startPingLoop();
    };

    channel.onclose = () => {
      setConnectionStatus(serverConnectedRef.current && currentRoomIdRef.current ? "Waiting" : "Disconnected");
      setInfoMessage("Data channel closed. Waiting for peer...");
      setLatencyMs(null);
      clearPingLoop();
    };

    channel.onerror = () => {
      setTransferState("error");
      setErrorMessage("Data channel error occurred.");
    };

    channel.onmessage = async (event) => {
      await handleDataMessage(event.data as string | ArrayBuffer | Blob);
    };
  }

  function createPeerConnection(remotePeerId: string): RTCPeerConnection {
    closePeerConnection();

    const pc = new RTCPeerConnection(RTC_CONFIG);
    remoteSocketIdRef.current = remotePeerId;
    peerConnectionRef.current = pc;

    pc.onicecandidate = (event) => {
      if (!event.candidate || !socketRef.current || !currentRoomIdRef.current || !remoteSocketIdRef.current) {
        return;
      }

      socketRef.current.emit("ice-candidate", {
        roomId: currentRoomIdRef.current,
        target: remoteSocketIdRef.current,
        candidate: event.candidate,
      });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        setConnectionStatus("Connected");
      }

      if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
        setConnectionStatus(serverConnectedRef.current && currentRoomIdRef.current ? "Waiting" : "Disconnected");
      }
    };

    pc.ondatachannel = (event) => {
      // The joining peer receives the channel created by the initiator.
      setupDataChannel(event.channel);
    };

    return pc;
  }

  async function beginOffer(remotePeerId: string) {
    const socket = socketRef.current;
    if (!socket || !currentRoomIdRef.current) return;

    const pc = createPeerConnection(remotePeerId);

    // The initiator creates a reliable ordered channel for chunk delivery.
    const outgoingChannel = pc.createDataChannel("file-transfer", { ordered: true });
    setupDataChannel(outgoingChannel);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socket.emit("offer", {
      roomId: currentRoomIdRef.current,
      target: remotePeerId,
      offer,
    });

    setConnectionStatus("Waiting");
    setInfoMessage("Offer created. Waiting for peer answer...");
  }

  async function startTransfer(file: File) {
    const channel = dataChannelRef.current;
    if (!channel || channel.readyState !== "open") {
      setErrorMessage("No active data channel. Connect to a peer first.");
      return;
    }

    cancelTransferRef.current = false;
    setTransferState("sending");
    setUploadProgress(0);

    const transferId = crypto.randomUUID?.() || `tx-${Date.now()}`;
    activeOutgoingTransferIdRef.current = transferId;

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    sendControlMessage({
      type: "file-meta",
      transferId,
      name: file.name,
      size: file.size,
      chunkSize: CHUNK_SIZE,
      totalChunks,
    });

    setUploadMeta(`${file.name} (${formatBytes(file.size)})`);

    let sentBytes = 0;

    try {
      for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
        if (cancelTransferRef.current) {
          sendControlMessage({ type: "cancel-transfer", transferId });
          setTransferState("cancelled");
          setInfoMessage("Transfer cancelled.");
          return;
        }

        const chunk = file.slice(offset, offset + CHUNK_SIZE);
        const chunkBuffer = await chunk.arrayBuffer();

        await waitForBufferedAmountLow(channel);

        if (channel.readyState !== "open") {
          throw new Error("Data channel closed while sending.");
        }

        channel.send(chunkBuffer);

        sentBytes += chunkBuffer.byteLength;
        setUploadProgress(Math.min(100, (sentBytes / file.size) * 100));
      }

      sendControlMessage({ type: "file-end", transferId });
      setTransferState("completed");
      setInfoMessage(`Upload complete: ${file.name}`);
    } catch {
      setTransferState("error");
      setErrorMessage("Transfer failed unexpectedly.");
    }
  }

  function leaveRoom() {
    socketRef.current?.emit("leave-room", () => {
      closePeerConnection();
      setCurrentRoomId("");
      currentRoomIdRef.current = "";
      setRoomInput("");
      setIsHost(false);
      setTransferState("idle");
      setSelectedFile(null);
      resetIncomingTransfer();
      resetOutgoingTransfer();
      setInfoMessage("You left the room.");
    });
  }

  function copyRoomCode() {
    if (!currentRoomId) return;
    navigator.clipboard.writeText(currentRoomId);
    setInfoMessage("Room code copied.");
  }

  function cancelTransfer() {
    if (transferState === "sending") {
      cancelTransferRef.current = true;
      return;
    }

    if (transferState === "receiving") {
      sendControlMessage({ type: "cancel-transfer" });
      resetIncomingTransfer();
      setTransferState("cancelled");
      setInfoMessage("Incoming transfer cancelled.");
    }
  }

  function retryTransfer() {
    if (!selectedFile) return;
    void startTransfer(selectedFile);
  }

  useEffect(() => {
    const socket = io(SIGNALING_URL, {
      transports: ["websocket"],
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setServerConnected(true);
      serverConnectedRef.current = true;
      setErrorMessage("");
      setConnectionStatus((prev) => (currentRoomIdRef.current ? prev : "Waiting"));
    });

    socket.on("disconnect", () => {
      setServerConnected(false);
      serverConnectedRef.current = false;
      setConnectionStatus("Disconnected");
      setInfoMessage("Disconnected from signaling server.");
      closePeerConnection();
    });

    socket.on("peer-joined", async ({ peerId, initiatorId }: { peerId: string; initiatorId: string }) => {
      setInfoMessage("Peer joined the room. Preparing connection...");
      setConnectionStatus("Waiting");

      if (socket.id === initiatorId) {
        await beginOffer(peerId);
      }
    });

    socket.on("offer", async ({ from, offer }: { from: string; offer: RTCSessionDescriptionInit }) => {
      if (!socketRef.current || !currentRoomIdRef.current) return;

      const pc = createPeerConnection(from);

      // The receiver applies the remote offer, then creates and sends an answer.
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socketRef.current.emit("answer", {
        roomId: currentRoomIdRef.current,
        target: from,
        answer,
      });
    });

    socket.on("answer", async ({ answer }: { answer: RTCSessionDescriptionInit }) => {
      const pc = peerConnectionRef.current;
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    });

    socket.on("ice-candidate", async ({ candidate }: { candidate: RTCIceCandidateInit }) => {
      const pc = peerConnectionRef.current;
      if (!pc || !candidate) return;

      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        setErrorMessage("Failed to add ICE candidate.");
      }
    });

    socket.on("peer-left", () => {
      closePeerConnection();
      setInfoMessage("Peer left the room.");
    });

    return () => {
      socket.disconnect();
      socket.removeAllListeners();
      closePeerConnection();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function createRoom() {
    const socket = socketRef.current;
    if (!socket || !serverConnected) {
      setErrorMessage("Not connected to signaling server.");
      return;
    }

    const requestedRoomId = roomInput.trim().toUpperCase() || generateRoomCode();

    socket.emit(
      "create-room",
      { roomId: requestedRoomId, password: passwordInput },
      (response: SignalingAck) => {
        if (!response.ok || !response.roomId) {
          setErrorMessage(response.message || "Could not create room.");
          return;
        }

        setErrorMessage("");
        setCurrentRoomId(response.roomId);
        currentRoomIdRef.current = response.roomId;
        setRoomInput(response.roomId);
        setIsHost(true);
        setConnectionStatus("Waiting");
        setInfoMessage("Room created. Share the code with your peer.");
      },
    );
  }

  function joinRoom() {
    const socket = socketRef.current;
    if (!socket || !serverConnected) {
      setErrorMessage("Not connected to signaling server.");
      return;
    }

    const normalizedRoom = roomInput.trim().toUpperCase();
    if (!normalizedRoom) {
      setErrorMessage("Enter a room code first.");
      return;
    }

    socket.emit("join-room", { roomId: normalizedRoom, password: passwordInput }, (response: SignalingAck) => {
      if (!response.ok || !response.roomId) {
        setErrorMessage(response.message || "Could not join room.");
        return;
      }

      setErrorMessage("");
      setCurrentRoomId(response.roomId);
      currentRoomIdRef.current = response.roomId;
      setIsHost(response.hostId === socket.id);
      setConnectionStatus("Waiting");
      setInfoMessage("Joined room. Waiting for signaling handshake...");
    });
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 px-4 py-6 md:px-8">
      <header className="panel">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-sea-300">Peer-to-Peer File Transfer</p>
            <h1 className="mt-2 text-3xl font-bold text-white md:text-4xl">Direct, encrypted, room-based sharing</h1>
            <p className="mt-2 text-sm text-slate-300">Signaling runs via Socket.IO, while files move over WebRTC DataChannel only.</p>
          </div>

          <div className="rounded-xl border border-white/20 bg-slate-900/80 px-4 py-3 text-sm">
            <p>
              Status: <span className="font-semibold text-amber-300">{connectionStatus}</span>
            </p>
            <p className="mt-1 text-slate-300">Server: {serverConnected ? "Online" : "Offline"}</p>
            <p className="mt-1 text-slate-300">Latency: {latencyMs ? `${latencyMs} ms` : "-"}</p>
          </div>
        </div>
      </header>

      <section className="grid gap-6 lg:grid-cols-2">
        <article className="panel">
          <h2 className="text-xl font-bold text-white">Room Controls</h2>
          <p className="mt-1 text-sm text-slate-300">Create a room or join one with room code and optional password.</p>

          <div className="mt-4 space-y-4">
            <div>
              <label className="field-label" htmlFor="room-id">
                Room ID
              </label>
              <input
                id="room-id"
                className="field-input font-mono uppercase"
                value={roomInput}
                maxLength={10}
                onChange={(event) => setRoomInput(event.target.value.toUpperCase())}
                placeholder="ABC123"
              />
            </div>

            <div>
              <label className="field-label" htmlFor="room-password">
                Optional Password
              </label>
              <input
                id="room-password"
                className="field-input"
                value={passwordInput}
                type="password"
                onChange={(event) => setPasswordInput(event.target.value)}
                placeholder="Set or enter room password"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <button className="btn-primary" onClick={createRoom} disabled={!serverConnected}>
                Create Room
              </button>
              <button className="btn-secondary" onClick={joinRoom} disabled={!serverConnected}>
                Join Room
              </button>
              <button className="btn-secondary" onClick={copyRoomCode} disabled={!currentRoomId}>
                Copy Room Code
              </button>
              <button className="btn-danger" onClick={leaveRoom} disabled={!currentRoomId}>
                Leave Room
              </button>
            </div>
          </div>

          <div className="mt-5 rounded-xl border border-white/15 bg-slate-950/70 p-4 text-sm text-slate-200">
            <p className="font-mono text-base text-amber-300">{currentRoomId || "No room active"}</p>
            <p className="mt-1">Role: {isHost ? "Host (offer initiator)" : "Joiner"}</p>
            <p className="mt-1 text-slate-300">{infoMessage}</p>
            {errorMessage && <p className="mt-2 rounded bg-rose-500/20 p-2 text-rose-200">{errorMessage}</p>}
          </div>
        </article>

        <article className="panel">
          <h2 className="text-xl font-bold text-white">File Transfer</h2>
          <p className="mt-1 text-sm text-slate-300">Chunk size: {formatBytes(CHUNK_SIZE)}. Files are sent directly peer-to-peer.</p>

          <div className="mt-4 space-y-4">
            <div>
              <label className="field-label" htmlFor="file-input">
                Select File
              </label>
              <input
                id="file-input"
                type="file"
                className="field-input file:mr-3 file:rounded-md file:border-0 file:bg-ember-500 file:px-3 file:py-1 file:text-sm file:font-semibold file:text-slate-950 hover:file:bg-ember-400"
                onChange={(event) => {
                  const nextFile = event.target.files?.[0] || null;
                  setSelectedFile(nextFile);
                  if (nextFile) {
                    setUploadMeta(`${nextFile.name} (${formatBytes(nextFile.size)})`);
                  }
                }}
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <button className="btn-primary" disabled={!canSendFile} onClick={() => selectedFile && void startTransfer(selectedFile)}>
                Send File
              </button>
              <button
                className="btn-danger"
                onClick={cancelTransfer}
                disabled={transferState !== "sending" && transferState !== "receiving"}
              >
                Cancel
              </button>
              <button className="btn-secondary" onClick={retryTransfer} disabled={!selectedFile || transferState === "sending"}>
                Retry
              </button>
            </div>
          </div>

          <div className="mt-5 space-y-4 text-sm">
            <div>
              <div className="mb-1 flex items-center justify-between text-slate-200">
                <span>Upload</span>
                <span>{uploadProgress.toFixed(1)}%</span>
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${uploadProgress}%` }} />
              </div>
              <p className="mt-1 text-xs text-slate-300">{uploadMeta || "No upload yet."}</p>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between text-slate-200">
                <span>Download</span>
                <span>{downloadProgress.toFixed(1)}%</span>
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${downloadProgress}%` }} />
              </div>
              <p className="mt-1 text-xs text-slate-300">{downloadMeta || "No download yet."}</p>
            </div>

            <div className="rounded-xl border border-white/10 bg-slate-950/50 p-3 text-xs uppercase tracking-[0.14em] text-slate-300">
              Transfer state: <span className="text-amber-300">{transferState}</span>
            </div>
          </div>
        </article>
      </section>
    </main>
  );
}

export default App;