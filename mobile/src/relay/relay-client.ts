/**
 * Phone-side WebSocket relay client.
 *
 * Connects to the Vox relay server, handles E2E encryption,
 * and provides send/receive for transcript data.
 */

import {
  generateKeyPair,
  encodePubKey,
  decodePubKey,
  encrypt,
  decrypt,
  isKeyExchange,
  computeFingerprint,
  type KeyPair,
} from "../crypto/e2e";

// Dev: use the host machine's local IP so the phone can reach the relay
// over WiFi without adb reverse. Set EXPO_PUBLIC_RELAY_HOST in mobile/.env
// (or mobile/.env.local) to override per network.
const DEV_RELAY_HOST = process.env.EXPO_PUBLIC_RELAY_HOST ?? "192.168.1.21";
const RELAY_URL = __DEV__
  ? `ws://${DEV_RELAY_HOST}:8080`
  : "wss://vox-relay.fly.dev";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export type RelayState =
  | "disconnected"
  | "connecting"
  | "joined"
  | "key-exchange"
  | "connected"
  | "reconnecting";

export interface RelayHandle {
  sendTranscript: (text: string) => void;
  disconnect: () => void;
  getState: () => RelayState;
  getFingerprint: () => string | null;
  getRoomCode: () => string;
}

interface RelayCallbacks {
  onStateChange: (state: RelayState) => void;
  onCorrection?: (text: string) => void;
  onSyncRequest?: () => string; // return current full transcript
  onError?: (msg: string) => void;
}

export function connectToRelay(
  roomCode: string,
  callbacks: RelayCallbacks
): RelayHandle {
  let ws: WebSocket | null = null;
  let keyPair: KeyPair = generateKeyPair();
  let peerPublicKey: Uint8Array | null = null;
  let fingerprint: string | null = null;
  let state: RelayState = "disconnected";
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function setState(s: RelayState) {
    state = s;
    callbacks.onStateChange(s);
  }

  function openSocket() {
    if (stopped) return;
    setState("connecting");

    try {
      ws = new WebSocket(RELAY_URL);
    } catch (e: any) {
      callbacks.onError?.(`WebSocket error: ${e?.message}`);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      reconnectAttempt = 0;
      ws!.send(JSON.stringify({ type: "join", room: roomCode }));
    };

    ws.onmessage = (event: MessageEvent) => {
      let msg: any;
      try { msg = JSON.parse(event.data); } catch { return; }
      handleMessage(msg);
    };

    ws.onclose = () => {
      if (!stopped) scheduleReconnect();
    };

    ws.onerror = () => {};
  }

  function handleMessage(msg: any) {
    switch (msg.type) {
      case "join":
        setState("joined");
        // Send our public key
        ws?.send(JSON.stringify({
          type: "relay",
          room: roomCode,
          payload: encodePubKey(keyPair.publicKey),
        }));
        break;

      case "peer-join":
        // Re-send public key for new peer
        ws?.send(JSON.stringify({
          type: "relay",
          room: roomCode,
          payload: encodePubKey(keyPair.publicKey),
        }));
        break;

      case "peer-leave":
        peerPublicKey = null;
        fingerprint = null;
        setState("joined");
        break;

      case "relay":
        handleRelayPayload(msg.payload);
        break;

      case "error":
        callbacks.onError?.(msg.message);
        break;
    }
  }

  function handleRelayPayload(payload: string) {
    if (!payload) return;

    // Key exchange
    const pk = decodePubKey(payload);
    if (pk) {
      peerPublicKey = pk;
      fingerprint = computeFingerprint(keyPair.publicKey, peerPublicKey);
      setState("connected");
      console.log(`[vox-relay] Peer connected, fingerprint: ${fingerprint}`);
      return;
    }

    // Encrypted message
    if (!peerPublicKey) return;
    const plaintext = decrypt(payload, peerPublicKey, keyPair.secretKey);
    if (!plaintext) return;

    let appMsg: any;
    try { appMsg = JSON.parse(plaintext); } catch { return; }

    switch (appMsg.type) {
      case "correction":
        callbacks.onCorrection?.(appMsg.text);
        break;
      case "sync-request":
        // Desktop is asking for the full transcript
        const fullText = callbacks.onSyncRequest?.() ?? "";
        sendEncrypted(JSON.stringify({ type: "sync-response", text: fullText, ts: Date.now() }));
        break;
    }
  }

  function sendEncrypted(jsonString: string) {
    if (!ws || ws.readyState !== 1 || !peerPublicKey) return;
    const payload = encrypt(jsonString, peerPublicKey, keyPair.secretKey);
    ws.send(JSON.stringify({ type: "relay", room: roomCode, payload }));
  }

  function scheduleReconnect() {
    if (stopped) return;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt), RECONNECT_MAX_MS);
    reconnectAttempt++;
    setState("reconnecting");
    reconnectTimer = setTimeout(() => {
      // Re-generate keys on reconnect (new ephemeral session)
      keyPair = generateKeyPair();
      peerPublicKey = null;
      fingerprint = null;
      openSocket();
    }, delay);
  }

  // Start
  openSocket();

  return {
    sendTranscript(text: string) {
      sendEncrypted(JSON.stringify({ type: "transcript", text, ts: Date.now() }));
    },

    disconnect() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        try { ws.close(); } catch {}
        ws = null;
      }
      setState("disconnected");
    },

    getState: () => state,
    getFingerprint: () => fingerprint,
    getRoomCode: () => roomCode,
  };
}
