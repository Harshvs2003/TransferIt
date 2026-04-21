import { useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { clearTransferChunks, getTransferBlob, storeChunk } from "./lib/transferStore";
import {
  getProfileConfig,
  makeChunkPacket,
  parseChunkPacket,
  RTC_CONFIG,
  waitForBufferedAmountLow,
} from "./lib/webrtc";
import type { TransferProfile } from "./lib/webrtc";
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
      startChunk: number;
      startBytes: number;
      reset: boolean;
      profile: TransferProfile;
    }
  | {
      type: "file-end";
      transferId: string;
      totalChunks: number;
    }
  | {
      type: "transfer-ack";
      transferId: string;
      receivedChunks: number;
      receivedBytes: number;
    }
  | { type: "cancel-transfer"; transferId?: string }
  | { type: "ping"; ts: number }
  | { type: "pong"; ts: number };

interface IncomingFile {
  transferId: string;
  name: string;
  size: number;
  chunkSize: number;
  totalChunks: number;
  expectedNextChunk: number;
}

interface SignalingAck {
  ok: boolean;
  roomId?: string;
  hostId?: string;
  message?: string;
}

const configuredSignalingUrl = (import.meta.env.VITE_SIGNALING_URL || "").trim();
const isLocalBrowser = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const configuredUsesLoopback = configuredSignalingUrl.includes("localhost") || configuredSignalingUrl.includes("127.0.0.1");
const hostBasedSignalingUrl = `${window.location.protocol}//${window.location.hostname}:4000`;
const SIGNALING_URL = configuredSignalingUrl
  ? (!isLocalBrowser && configuredUsesLoopback ? hostBasedSignalingUrl : configuredSignalingUrl)
  : hostBasedSignalingUrl;

function App() {
  const socketRef = useRef<Socket | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const remoteSocketIdRef = useRef<string | null>(null);
  const incomingFileRef = useRef<IncomingFile | null>(null);
  const receivedBytesRef = useRef(0);
  const activeOutgoingTransferIdRef = useRef<string | null>(null);
  const cancelTransferRef = useRef(false);
  const pingIntervalRef = useRef<number | null>(null);
  const currentRoomIdRef = useRef("");
  const serverConnectedRef = useRef(false);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const uploadUiUpdateTsRef = useRef(0);
  const downloadUiUpdateTsRef = useRef(0);
  const uploadStartTsRef = useRef(0);
  const downloadStartTsRef = useRef(0);
  const lastAckedChunkRef = useRef(0);
  const lastAckedBytesRef = useRef(0);

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
  const [dataChannelReady, setDataChannelReady] = useState(false);
  const [transferProfile, setTransferProfile] = useState<TransferProfile>("internet");
  const [uploadRate, setUploadRate] = useState(0);
  const [downloadRate, setDownloadRate] = useState(0);

  const profileConfig = useMemo(() => getProfileConfig(transferProfile), [transferProfile]);

  const canSendFile = useMemo(
    () => Boolean(selectedFile && dataChannelReady && transferState !== "sending"),
    [selectedFile, dataChannelReady, transferState],
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

  async function resetIncomingTransfer(clearChunks = true) {
    const incoming = incomingFileRef.current;
    incomingFileRef.current = null;
    receivedBytesRef.current = 0;
    downloadStartTsRef.current = 0;
    setDownloadProgress(0);
    setDownloadMeta("");
    setDownloadRate(0);

    if (clearChunks && incoming?.transferId) {
      try {
        await clearTransferChunks(incoming.transferId);
      } catch {
        // ignore
      }
    }
  }

  function resetOutgoingTransfer() {
    activeOutgoingTransferIdRef.current = null;
    cancelTransferRef.current = false;
    uploadStartTsRef.current = 0;
    lastAckedChunkRef.current = 0;
    lastAckedBytesRef.current = 0;
    setUploadProgress(0);
    setUploadMeta("");
    setUploadRate(0);
  }

  function closePeerConnection() {
    dataChannelRef.current?.close();
    dataChannelRef.current = null;

    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;

    remoteSocketIdRef.current = null;
    pendingIceCandidatesRef.current = [];
    setDataChannelReady(false);
    setConnectionStatus(serverConnectedRef.current && currentRoomIdRef.current ? "Waiting" : "Disconnected");
    setLatencyMs(null);
    clearPingLoop();
  }

  function sendControlMessage(message: ControlMessage) {
    const channel = dataChannelRef.current;
    if (!channel || channel.readyState !== "open") return;
    channel.send(JSON.stringify(message));
  }

  function triggerDownload(name: string, fileBlob: Blob) {
    const objectUrl = URL.createObjectURL(fileBlob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
  }

  function throttledUploadProgress(bytesSent: number, fileSize: number) {
    const now = performance.now();
    if (now - uploadUiUpdateTsRef.current < profileConfig.uiUpdateIntervalMs && bytesSent < fileSize) {
      return;
    }
    uploadUiUpdateTsRef.current = now;
    setUploadProgress(Math.min(100, (bytesSent / fileSize) * 100));
    if (uploadStartTsRef.current > 0) {
      const elapsedSec = Math.max(0.001, (now - uploadStartTsRef.current) / 1000);
      setUploadRate(bytesSent / elapsedSec / (1024 * 1024));
    }
  }

  function throttledDownloadProgress(bytesReceived: number, fileSize: number) {
    const now = performance.now();
    if (now - downloadUiUpdateTsRef.current < profileConfig.uiUpdateIntervalMs && bytesReceived < fileSize) {
      return;
    }
    downloadUiUpdateTsRef.current = now;
    setDownloadProgress(Math.min(100, (bytesReceived / fileSize) * 100));
    if (downloadStartTsRef.current > 0) {
      const elapsedSec = Math.max(0.001, (now - downloadStartTsRef.current) / 1000);
      setDownloadRate(bytesReceived / elapsedSec / (1024 * 1024));
    }
  }

  function maybeSendAck(fileMeta: IncomingFile, force = false) {
    if (!force && fileMeta.expectedNextChunk % profileConfig.ackEveryChunks !== 0) {
      return;
    }

    sendControlMessage({
      type: "transfer-ack",
      transferId: fileMeta.transferId,
      receivedChunks: fileMeta.expectedNextChunk,
      receivedBytes: receivedBytesRef.current,
    });
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

      if (control.type === "transfer-ack") {
        if (control.transferId === activeOutgoingTransferIdRef.current) {
          lastAckedChunkRef.current = Math.max(lastAckedChunkRef.current, control.receivedChunks);
          lastAckedBytesRef.current = Math.max(lastAckedBytesRef.current, control.receivedBytes);
        }
        return;
      }

      if (control.type === "cancel-transfer") {
        await resetIncomingTransfer(true);
        setTransferState("cancelled");
        setInfoMessage("Transfer cancelled by peer.");
        return;
      }

      if (control.type === "file-meta") {
        if (control.reset) {
          await clearTransferChunks(control.transferId);
        }

        incomingFileRef.current = {
          transferId: control.transferId,
          name: control.name,
          size: control.size,
          chunkSize: control.chunkSize,
          totalChunks: control.totalChunks,
          expectedNextChunk: control.startChunk,
        };

        receivedBytesRef.current = control.startBytes;
        downloadStartTsRef.current = performance.now();
        setTransferState("receiving");
        throttledDownloadProgress(receivedBytesRef.current, control.size);
        setDownloadMeta(`${control.name} (${formatBytes(control.size)})`);
        setInfoMessage(control.startChunk > 0 ? "Resuming incoming transfer..." : "Receiving file...");
        maybeSendAck(incomingFileRef.current, true);
        return;
      }

      if (control.type === "file-end") {
        const fileMeta = incomingFileRef.current;
        if (!fileMeta || fileMeta.transferId !== control.transferId) {
          return;
        }

        await writeQueueRef.current;
        maybeSendAck(fileMeta, true);

        try {
          const blob = await getTransferBlob(fileMeta.transferId, control.totalChunks);
          triggerDownload(fileMeta.name, blob);
          setDownloadProgress(100);
          setTransferState("completed");
          setInfoMessage(`Download complete: ${fileMeta.name}`);
        } catch {
          setTransferState("error");
          setErrorMessage("Download reconstruction failed. Try retrying the transfer.");
        } finally {
          await clearTransferChunks(fileMeta.transferId);
          incomingFileRef.current = null;
        }
      }

      return;
    }

    const packet = rawData instanceof Blob ? await rawData.arrayBuffer() : rawData;
    const fileMeta = incomingFileRef.current;
    if (!fileMeta) return;

    const { index, payload } = parseChunkPacket(packet);

    if (index < fileMeta.expectedNextChunk) {
      return;
    }

    if (index > fileMeta.expectedNextChunk) {
      setErrorMessage("Chunk sequence mismatch. Please retry transfer.");
      return;
    }

    writeQueueRef.current = writeQueueRef.current.then(() => storeChunk(fileMeta.transferId, index, payload));

    fileMeta.expectedNextChunk += 1;
    receivedBytesRef.current += payload.byteLength;
    throttledDownloadProgress(receivedBytesRef.current, fileMeta.size);
    maybeSendAck(fileMeta);
  }

  function setupDataChannel(channel: RTCDataChannel) {
    dataChannelRef.current = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = profileConfig.bufferedAmountLimit;
    setDataChannelReady(false);

    channel.onopen = () => {
      setDataChannelReady(true);
      setConnectionStatus("Connected");
      setErrorMessage("");
      setInfoMessage("Peer connection is ready. You can transfer files now.");
      startPingLoop();
    };

    channel.onclose = () => {
      setDataChannelReady(false);
      setConnectionStatus(serverConnectedRef.current && currentRoomIdRef.current ? "Waiting" : "Disconnected");
      setInfoMessage("Data channel closed. Waiting for peer...");
      setLatencyMs(null);
      clearPingLoop();
    };

    channel.onerror = () => {
      setDataChannelReady(false);
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
    pendingIceCandidatesRef.current = [];

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

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "checking") {
        setInfoMessage("Negotiating ICE candidates...");
      }

      if (pc.iceConnectionState === "failed") {
        setErrorMessage("Peer connection failed. Retry or use a TURN server for restrictive networks.");
      }
    };

    pc.ondatachannel = (event) => {
      setupDataChannel(event.channel);
    };

    return pc;
  }

  async function flushPendingIceCandidates() {
    const pc = peerConnectionRef.current;
    if (!pc || !pc.remoteDescription) return;

    while (pendingIceCandidatesRef.current.length > 0) {
      const candidate = pendingIceCandidatesRef.current.shift();
      if (!candidate) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        setErrorMessage("Failed to add queued ICE candidate.");
      }
    }
  }

  async function beginOffer(remotePeerId: string) {
    const socket = socketRef.current;
    if (!socket || !currentRoomIdRef.current) return;

    const pc = createPeerConnection(remotePeerId);

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

  async function readChunk(file: File, index: number, chunkSize: number): Promise<ArrayBuffer> {
    const start = index * chunkSize;
    const chunk = file.slice(start, start + chunkSize);
    return chunk.arrayBuffer();
  }

  async function startTransfer(file: File, resume = false) {
    const channel = dataChannelRef.current;
    if (!channel || channel.readyState !== "open") {
      if (isHost && remoteSocketIdRef.current) {
        setInfoMessage("Data channel is not ready yet. Retrying negotiation...");
        setErrorMessage("");
        await beginOffer(remoteSocketIdRef.current);
        return;
      }
      setErrorMessage("No active data channel. Connect to a peer first.");
      return;
    }

    cancelTransferRef.current = false;
    setTransferState("sending");
    uploadStartTsRef.current = performance.now();
    uploadUiUpdateTsRef.current = 0;
    setUploadRate(0);

    const chunkSize = profileConfig.chunkSize;
    const totalChunks = Math.ceil(file.size / chunkSize);

    const transferId = resume && activeOutgoingTransferIdRef.current
      ? activeOutgoingTransferIdRef.current
      : crypto.randomUUID?.() || `tx-${Date.now()}`;

    activeOutgoingTransferIdRef.current = transferId;

    const startChunk = resume ? lastAckedChunkRef.current : 0;
    const startBytes = resume ? lastAckedBytesRef.current : 0;

    if (!resume) {
      lastAckedChunkRef.current = 0;
      lastAckedBytesRef.current = 0;
    }

    sendControlMessage({
      type: "file-meta",
      transferId,
      name: file.name,
      size: file.size,
      chunkSize,
      totalChunks,
      startChunk,
      startBytes,
      reset: !resume,
      profile: transferProfile,
    });

    setUploadMeta(`${file.name} (${formatBytes(file.size)}) | ${transferProfile.toUpperCase()} profile`);

    let sentBytes = startBytes;

    try {
      let preloaded = await readChunk(file, startChunk, chunkSize);

      for (let chunkIndex = startChunk; chunkIndex < totalChunks; chunkIndex += 1) {
        if (cancelTransferRef.current) {
          sendControlMessage({ type: "cancel-transfer", transferId });
          setTransferState("cancelled");
          setInfoMessage("Transfer cancelled.");
          return;
        }

        const hasNext = chunkIndex + 1 < totalChunks;
        const nextPromise = hasNext ? readChunk(file, chunkIndex + 1, chunkSize) : null;

        await waitForBufferedAmountLow(channel, profileConfig.bufferedAmountLimit);

        if (channel.readyState !== "open") {
          throw new Error("Data channel closed while sending.");
        }

        channel.send(makeChunkPacket(chunkIndex, preloaded));
        sentBytes += preloaded.byteLength;
        throttledUploadProgress(sentBytes, file.size);

        if (hasNext && nextPromise) {
          // eslint-disable-next-line no-await-in-loop
          preloaded = await nextPromise;
        }
      }

      sendControlMessage({ type: "file-end", transferId, totalChunks });
      setUploadProgress(100);
      setTransferState("completed");
      setInfoMessage(`Upload complete: ${file.name}`);
    } catch {
      setTransferState("error");
      setErrorMessage("Transfer failed unexpectedly.");
    }
  }

  function leaveRoom() {
    socketRef.current?.emit("leave-room", async () => {
      closePeerConnection();
      setCurrentRoomId("");
      currentRoomIdRef.current = "";
      setRoomInput("");
      setIsHost(false);
      setTransferState("idle");
      setSelectedFile(null);
      await resetIncomingTransfer(true);
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
      void resetIncomingTransfer(true);
      setTransferState("cancelled");
      setInfoMessage("Incoming transfer cancelled.");
    }
  }

  function retryTransfer() {
    if (!selectedFile) return;
    void startTransfer(selectedFile, true);
  }

  useEffect(() => {
    const socket = io(SIGNALING_URL);

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

      try {
        setInfoMessage("Offer received. Sending answer...");
        const pc = createPeerConnection(from);

        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        await flushPendingIceCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        socketRef.current.emit("answer", {
          roomId: currentRoomIdRef.current,
          target: from,
          answer,
        });
      } catch {
        setErrorMessage("Failed to process incoming offer.");
      }
    });

    socket.on("answer", async ({ answer }: { answer: RTCSessionDescriptionInit }) => {
      const pc = peerConnectionRef.current;
      if (!pc) return;
      try {
        setInfoMessage("Answer received. Finalizing peer connection...");
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        await flushPendingIceCandidates();
      } catch {
        setErrorMessage("Failed to apply peer answer.");
      }
    });

    socket.on("ice-candidate", async ({ candidate }: { candidate: RTCIceCandidateInit }) => {
      const pc = peerConnectionRef.current;
      if (!pc || !candidate) return;

      try {
        if (!pc.remoteDescription) {
          pendingIceCandidatesRef.current.push(candidate);
          return;
        }

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
          <p className="mt-1 text-sm text-slate-300">
            Chunk size: {formatBytes(profileConfig.chunkSize)} | Buffer: {formatBytes(profileConfig.bufferedAmountLimit)}
          </p>

          <div className="mt-4 space-y-4">
            <div>
              <label className="field-label" htmlFor="transfer-profile">
                Transfer Profile
              </label>
              <select
                id="transfer-profile"
                className="field-input"
                value={transferProfile}
                onChange={(event) => setTransferProfile(event.target.value as TransferProfile)}
                disabled={transferState === "sending" || transferState === "receiving"}
              >
                <option value="internet">Internet (stable)</option>
                <option value="lan">LAN (maximum speed)</option>
              </select>
            </div>

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
              <button className="btn-primary" disabled={!canSendFile} onClick={() => selectedFile && void startTransfer(selectedFile, false)}>
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
                Resume/Retry
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
              <p className="mt-1 text-xs text-sea-300">Throughput: {uploadRate.toFixed(2)} MB/s</p>
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
              <p className="mt-1 text-xs text-sea-300">Throughput: {downloadRate.toFixed(2)} MB/s</p>
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
