/**
 * Vox Desktop Receiver
 *
 * Vanilla JS SPA. Connects to the relay via WebSocket,
 * does E2E decryption via tweetnacl, renders live transcript.
 */

// ── Config ──

const RELAY_URL = localStorage.getItem("vox-relay-url") || "ws://localhost:8080";
const PREFIX_PUBKEY = 0x00;
const PREFIX_BOX = 0x01;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

// ── State ──

let ws = null;
let roomCode = "";
let myKeyPair = null;
let peerPublicKey = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let transcript = "";
let isEditing = false; // true while doctor is editing on desktop

// ── DOM ──

const connectScreen = document.getElementById("connect-screen");
const dictationScreen = document.getElementById("dictation-screen");
const roomInput = document.getElementById("room-input");
const connectBtn = document.getElementById("connect-btn");
const connectError = document.getElementById("connect-error");
const statusDot = document.getElementById("status-dot");
const statusLabel = document.getElementById("status-label");
const roomDisplay = document.getElementById("room-display");
const fingerprintDisplay = document.getElementById("fingerprint-display");
const transcriptArea = document.getElementById("transcript");
const copyBtn = document.getElementById("copy-btn");
const exportBtn = document.getElementById("export-btn");
const disconnectBtn = document.getElementById("disconnect-btn");

// ── Crypto ──

function generateKeyPair() {
  return nacl.box.keyPair();
}

function encodePubKey(publicKey) {
  const msg = new Uint8Array(1 + publicKey.length);
  msg[0] = PREFIX_PUBKEY;
  msg.set(publicKey, 1);
  return uint8ToBase64(msg);
}

function decodePubKey(base64) {
  const bytes = base64ToUint8(base64);
  if (bytes.length < 33 || bytes[0] !== PREFIX_PUBKEY) return null;
  return bytes.slice(1, 33);
}

function encryptMsg(plaintext, peerPk, mySk) {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const msgBytes = new TextEncoder().encode(plaintext);
  const ciphertext = nacl.box(msgBytes, nonce, peerPk, mySk);
  const blob = new Uint8Array(1 + nonce.length + ciphertext.length);
  blob[0] = PREFIX_BOX;
  blob.set(nonce, 1);
  blob.set(ciphertext, 1 + nonce.length);
  return uint8ToBase64(blob);
}

function decryptMsg(base64, peerPk, mySk) {
  const blob = base64ToUint8(base64);
  if (blob.length < 1 + nacl.box.nonceLength + 1 || blob[0] !== PREFIX_BOX) return null;
  const nonce = blob.slice(1, 1 + nacl.box.nonceLength);
  const ciphertext = blob.slice(1 + nacl.box.nonceLength);
  const plain = nacl.box.open(ciphertext, nonce, peerPk, mySk);
  if (!plain) return null;
  return new TextDecoder().decode(plain);
}

function computeFingerprint(myPk, peerPk) {
  const sorted = [myPk, peerPk].sort((a, b) => {
    for (let i = 0; i < 32; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  });
  const combined = new Uint8Array(64);
  combined.set(sorted[0], 0);
  combined.set(sorted[1], 32);
  const hash = nacl.hash(combined);
  const num = ((hash[0] << 8) | hash[1]) % 10000;
  return String(num).padStart(4, "0");
}

// ── Base64 ──

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function uint8ToBase64(bytes) {
  let r = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i+1] || 0, b2 = bytes[i+2] || 0;
    r += B64[b0>>2] + B64[((b0&3)<<4)|(b1>>4)];
    r += i+1 < bytes.length ? B64[((b1&15)<<2)|(b2>>6)] : "=";
    r += i+2 < bytes.length ? B64[b2&63] : "=";
  }
  return r;
}

function base64ToUint8(b64) {
  const clean = b64.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let j = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64.indexOf(clean[i]), b = B64.indexOf(clean[i+1]);
    const c = i+2 < clean.length ? B64.indexOf(clean[i+2]) : 0;
    const d = i+3 < clean.length ? B64.indexOf(clean[i+3]) : 0;
    out[j++] = (a<<2)|(b>>4);
    if (i+2 < clean.length) out[j++] = ((b&15)<<4)|(c>>2);
    if (i+3 < clean.length) out[j++] = ((c&3)<<6)|d;
  }
  return out.slice(0, j);
}

// ── WebSocket ──

function connect(code) {
  roomCode = code.toUpperCase().trim();
  myKeyPair = generateKeyPair();
  peerPublicKey = null;
  reconnectAttempt = 0;

  showDictationScreen();
  setStatus("connecting");
  openSocket();
}

function openSocket() {
  if (ws) {
    try { ws.close(); } catch {}
  }

  ws = new WebSocket(RELAY_URL);

  ws.onopen = () => {
    setStatus("joining");
    ws.send(JSON.stringify({ type: "join", room: roomCode }));
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleMessage(msg);
  };

  ws.onclose = () => {
    if (roomCode) scheduleReconnect();
  };

  ws.onerror = () => {};
}

function handleMessage(msg) {
  switch (msg.type) {
    case "join":
      setStatus("waiting");
      // Send our public key
      ws.send(JSON.stringify({
        type: "relay",
        room: roomCode,
        payload: encodePubKey(myKeyPair.publicKey),
      }));
      break;

    case "peer-join":
      setStatus("key-exchange");
      // Re-send public key for the new peer
      ws.send(JSON.stringify({
        type: "relay",
        room: roomCode,
        payload: encodePubKey(myKeyPair.publicKey),
      }));
      break;

    case "peer-leave":
      peerPublicKey = null;
      setStatus("waiting");
      fingerprintDisplay.textContent = "";
      break;

    case "relay":
      handleRelayMessage(msg.payload);
      break;

    case "error":
      showError(msg.message);
      break;

    case "pong":
      break;
  }
}

function handleRelayMessage(payload) {
  if (!payload) return;

  // Try key exchange first
  const pk = decodePubKey(payload);
  if (pk) {
    peerPublicKey = pk;
    const fp = computeFingerprint(myKeyPair.publicKey, peerPublicKey);
    fingerprintDisplay.textContent = "Verification: " + fp;
    setStatus("connected");

    // Request full sync
    sendEncrypted(JSON.stringify({ type: "sync-request", ts: Date.now() }));
    return;
  }

  // Try decryption
  if (!peerPublicKey) return;
  const plaintext = decryptMsg(payload, peerPublicKey, myKeyPair.secretKey);
  if (!plaintext) return;

  let appMsg;
  try { appMsg = JSON.parse(plaintext); } catch { return; }
  handleAppMessage(appMsg);
}

function handleAppMessage(msg) {
  switch (msg.type) {
    case "transcript":
    case "sync-response":
      transcript = msg.text || "";
      // Don't touch the DOM while the doctor's caret is in the text.
      // The variable updates (no data loss), DOM catches up on blur.
      if (!isEditing && document.activeElement !== transcriptArea) {
        renderTranscript();
      }
      break;
  }
}

function sendEncrypted(jsonString) {
  if (!ws || ws.readyState !== 1 || !peerPublicKey) return;
  const encrypted = encryptMsg(jsonString, peerPublicKey, myKeyPair.secretKey);
  ws.send(JSON.stringify({ type: "relay", room: roomCode, payload: encrypted }));
}

function scheduleReconnect() {
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt), RECONNECT_MAX_MS);
  reconnectAttempt++;
  setStatus("reconnecting");
  reconnectTimer = setTimeout(openSocket, delay);
}

function disconnect() {
  roomCode = "";
  peerPublicKey = null;
  myKeyPair = null;
  transcript = "";
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  showConnectScreen();
}

// ── UI ──

function showConnectScreen() {
  connectScreen.hidden = false;
  dictationScreen.hidden = true;
  roomInput.value = "";
  connectError.hidden = true;
  roomInput.focus();
}

function showDictationScreen() {
  connectScreen.hidden = true;
  dictationScreen.hidden = false;
  roomDisplay.textContent = roomCode;
  fingerprintDisplay.textContent = "";
  transcriptArea.innerHTML = '<p class="placeholder">En attente de la dictee...</p>';
}

function setStatus(state) {
  const labels = {
    connecting: "Connexion...",
    joining: "Connexion au salon...",
    waiting: "En attente du telephone...",
    "key-exchange": "Echange de cles...",
    connected: "Connecte",
    reconnecting: "Reconnexion...",
  };
  statusLabel.textContent = labels[state] || state;

  statusDot.className = "dot";
  if (state === "connected") statusDot.classList.add("dot-green");
  else if (state === "reconnecting") statusDot.classList.add("dot-yellow");
  else statusDot.classList.add("dot-gray");
}

function renderTranscript() {
  if (!transcript.trim()) {
    transcriptArea.innerHTML = "";
    const ph = document.createElement("p");
    ph.className = "placeholder";
    ph.textContent = "En attente de la dictee...";
    transcriptArea.appendChild(ph);
    transcriptArea.contentEditable = "false";
    return;
  }
  // Use textContent (not innerHTML) to prevent XSS, append cursor via DOM API
  transcriptArea.textContent = transcript;
  const cursor = document.createElement("span");
  cursor.className = "cursor";
  transcriptArea.appendChild(cursor);
  transcriptArea.contentEditable = "true";
}

function showError(msg) {
  connectError.textContent = msg;
  connectError.hidden = false;
}

// ── Actions ──

copyBtn.addEventListener("click", async () => {
  if (!transcript) return;
  try {
    await navigator.clipboard.writeText(transcript);
    copyBtn.textContent = "Copie !";
    setTimeout(() => { copyBtn.textContent = "Copier tout"; }, 1500);
  } catch {
    // Fallback
    const ta = document.createElement("textarea");
    ta.value = transcript;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    copyBtn.textContent = "Copie !";
    setTimeout(() => { copyBtn.textContent = "Copier tout"; }, 1500);
  }
});

exportBtn.addEventListener("click", () => {
  if (!transcript) return;
  const blob = new Blob([transcript], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `vox-${roomCode}-${new Date().toISOString().slice(0, 10)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
});

disconnectBtn.addEventListener("click", disconnect);

connectBtn.addEventListener("click", () => {
  const code = roomInput.value.trim().toUpperCase();
  if (!code.match(/^[A-Z]+-[A-Z]+-\d{2}$/)) {
    showError("Format: MOT-MOT-00 (ex: BLEU-TIGRE-42)");
    return;
  }
  connectError.hidden = true;
  connect(code);
});

roomInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") connectBtn.click();
});

// ── Editing ──
// Detect actual typing (not just focus/click) via `input` event.
// Auto-resume incoming updates after 2s of no typing.

let editIdleTimer = null;

transcriptArea.addEventListener("input", () => {
  if (!isEditing) {
    isEditing = true;
    // Remove the blinking cursor while editing (doctor uses real cursor)
    const cursor = transcriptArea.querySelector(".cursor");
    if (cursor) cursor.remove();
  }
  // Reset idle timer on every keystroke
  if (editIdleTimer) clearTimeout(editIdleTimer);
  editIdleTimer = setTimeout(finishEditing, 500);
});

function finishEditing() {
  if (!isEditing) return;
  isEditing = false;
  editIdleTimer = null;
  // Read the edited text from the DOM and send correction.
  // Do NOT re-render here — that would destroy the caret position.
  // The blur handler re-renders when the doctor clicks away.
  const editedText = transcriptArea.innerText.trim();
  if (editedText && editedText !== transcript) {
    transcript = editedText;
    sendEncrypted(JSON.stringify({
      type: "correction",
      text: editedText,
      ts: Date.now(),
    }));
  }
}

// On blur: finalize any edit, then always re-render to catch up with latest transcript
transcriptArea.addEventListener("blur", () => {
  finishEditing();
  renderTranscript();
});

// Prevent Enter from inserting <div> elements in contenteditable
transcriptArea.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    document.execCommand("insertText", false, "\n");
  }
});

// ── Init ──
roomInput.focus();
