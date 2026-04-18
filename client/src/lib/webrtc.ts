export const CHUNK_SIZE = 64 * 1024;
export const BUFFERED_AMOUNT_LIMIT = CHUNK_SIZE * 8;

export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

export function waitForBufferedAmountLow(channel: RTCDataChannel): Promise<void> {
  if (channel.bufferedAmount <= BUFFERED_AMOUNT_LIMIT) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const check = () => {
      if (channel.readyState !== "open") {
        resolve();
        return;
      }

      if (channel.bufferedAmount <= BUFFERED_AMOUNT_LIMIT) {
        resolve();
        return;
      }

      setTimeout(check, 20);
    };

    check();
  });
}