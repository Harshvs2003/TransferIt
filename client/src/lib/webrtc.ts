export type TransferProfile = "internet" | "lan";

interface ProfileConfig {
  chunkSize: number;
  bufferedAmountLimit: number;
  ackEveryChunks: number;
  uiUpdateIntervalMs: number;
}

const KB = 1024;

export const PROFILE_CONFIG: Record<TransferProfile, ProfileConfig> = {
  internet: {
    chunkSize: 256 * KB,
    bufferedAmountLimit: 2 * 1024 * KB,
    ackEveryChunks: 32,
    uiUpdateIntervalMs: 150,
  },
  lan: {
    chunkSize: 512 * KB,
    bufferedAmountLimit: 8 * 1024 * KB,
    ackEveryChunks: 64,
    uiUpdateIntervalMs: 100,
  },
};

export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

export function getProfileConfig(profile: TransferProfile): ProfileConfig {
  return PROFILE_CONFIG[profile];
}

export function makeChunkPacket(index: number, payload: ArrayBuffer): ArrayBuffer {
  const header = new ArrayBuffer(4);
  new DataView(header).setUint32(0, index, false);

  const merged = new Uint8Array(4 + payload.byteLength);
  merged.set(new Uint8Array(header), 0);
  merged.set(new Uint8Array(payload), 4);
  return merged.buffer;
}

export function parseChunkPacket(packet: ArrayBuffer): { index: number; payload: ArrayBuffer } {
  const view = new DataView(packet);
  const index = view.getUint32(0, false);
  const payload = packet.slice(4);
  return { index, payload };
}

export function waitForBufferedAmountLow(channel: RTCDataChannel, threshold: number): Promise<void> {
  channel.bufferedAmountLowThreshold = threshold;

  if (channel.bufferedAmount <= threshold) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const onLow = () => {
      channel.removeEventListener("bufferedamountlow", onLow);
      resolve();
    };

    channel.addEventListener("bufferedamountlow", onLow);
  });
}