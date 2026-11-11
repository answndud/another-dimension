import { compareMessageOrder, messageInsertionIndex } from "./history-order.js";
import { RelayRoom } from "./relay-room.js";

const CODE_PREFIX = "AD1-";
const CODE_BYTES = 64;
const SESSION_CODE_KEY = "another-dimension.room-code.v1";
const views = [...document.querySelectorAll("main > section")];
const home = document.querySelector("#home-view");
const createView = document.querySelector("#create-view");
const joinView = document.querySelector("#join-view");
const roomView = document.querySelector("#room-view");
const createdCode = document.querySelector("#created-code");
const joinCode = document.querySelector("#join-code");
const createFeedback = document.querySelector("#create-feedback");
const joinError = document.querySelector("#join-error");
const privacyDialog = document.querySelector("#privacy-dialog");
const confirmDialog = document.querySelector("#confirm-dialog");
const confirmTitle = document.querySelector("#confirm-title");
const confirmDescription = document.querySelector("#confirm-description");
const confirmAction = document.querySelector("#confirm-action");
const roomStatus = document.querySelector("#room-status");
const sessionNote = document.querySelector("#session-note");
const historyStatus = document.querySelector("#history-status");
const messageForm = document.querySelector("#message-form");
const messageInput = document.querySelector("#message-input");
const sendButton = document.querySelector("#send-button");
const messageError = document.querySelector("#message-error");
const messagesElement = document.querySelector("#messages");
const notificationButton = document.querySelector("#notification-button");
let notificationWorker = null;
let codeVisible = false;
let room = null;
let roomVersion = 0;
let messages = [];
const messageElements = new Map();

function showView(view) {
  for (const section of views) section.hidden = section !== view;
  view.querySelector("h2")?.focus({ preventScroll: true });
}

function clearInputs() {
  createdCode.value = "";
  joinCode.value = "";
  createFeedback.textContent = "";
  joinError.textContent = "";
  joinCode.removeAttribute("aria-invalid");
  codeVisible = false;
}

function confirmActionDialog(title, description, action) {
  confirmTitle.textContent = title;
  confirmDescription.textContent = description;
  confirmAction.textContent = action;
  confirmDialog.returnValue = "";
  return new Promise((resolve) => {
    confirmDialog.addEventListener("close", () => resolve(confirmDialog.returnValue === "confirm"), { once: true });
    confirmDialog.showModal();
  });
}

async function returnHome() {
  if (!roomView.hidden && !await confirmActionDialog("방을 나가시겠습니까?", "방을 나가면 이 화면의 대화 내용이 삭제됩니다.", "방 나가기")) return;
  roomVersion++;
  clearSessionCode();
  room?.close();
  room = null;
  messages = [];
  messageElements.clear();
  messagesElement.replaceChildren();
  messageInput.value = "";
  messageInput.disabled = true;
  sendButton.disabled = true;
  messageError.textContent = "";
  sessionNote.textContent = "";
  historyStatus.textContent = "";
  clearInputs();
  showView(home);
}

function generateCode() {
  if (!window.isSecureContext || !globalThis.crypto?.getRandomValues) {
    createFeedback.textContent = "안전한 환경에서 코드를 생성할 수 없습니다. HTTPS 또는 localhost에서 다시 시도해 주세요.";
    return false;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_BYTES));
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  bytes.fill(0);
  createdCode.value = CODE_PREFIX + encoded;
  codeVisible = true;
  createFeedback.textContent = "";
  return true;
}

function isValidCode(input) {
  if (!input.startsWith(CODE_PREFIX)) return false;
  const encoded = input.slice(CODE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{86}$/.test(encoded)) return false;
  try {
    const decoded = atob(encoded.replaceAll("-", "+").replaceAll("_", "/") + "==");
    const canonical = btoa(decoded).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    return decoded.length === CODE_BYTES && canonical === encoded;
  } catch {
    return false;
  }
}

async function enterRoom(code) {
  const version = ++roomVersion;
  const remembered = rememberSessionCode(code);
  clearInputs();
  showView(roomView);
  roomStatus.textContent = "연결 중";
  messageInput.disabled = true;
  sendButton.disabled = true;
  sessionNote.textContent = remembered ? "" : "새로고침하면 코드를 다시 입력해야 합니다.";
  try {
    const pendingRoom = await RelayRoom.create(code, {
      status: (status) => { if (version === roomVersion) roomStatus.textContent = status; },
      connected: (connected) => {
        if (version !== roomVersion) return;
        messageInput.disabled = !connected;
        sendButton.disabled = !connected;
        for (const button of messagesElement.querySelectorAll(".retry-message")) button.disabled = !connected;
        if (connected) markVisibleMessagesRead();
        else historyStatus.textContent = "";
      },
      message: (message) => version === roomVersion && receiveMessage(message),
      receipt: (receipt) => { if (version === roomVersion) updateReceipt(receipt); },
      historySnapshot: () => version === roomVersion ? ({
        floor: null,
        messages: messages.filter((message) => !message.mine || message.delivered || message.read)
          .map(({ id, text, at, mine, read }) => ({ id, text, at, mine, read: read === true })),
      }) : null,
      historyBatch: (batch) => { if (version === roomVersion) restoreHistory(batch); },
      historyStatus: (status) => { if (version === roomVersion) historyStatus.textContent = status; },
    });
    if (version !== roomVersion) { pendingRoom.close(); return; }
    room = pendingRoom;
    room.start();
  } catch {
    if (version === roomVersion) roomStatus.textContent = "연결을 시작할 수 없습니다";
  }
}

function rememberSessionCode(code) {
  try {
    sessionStorage.setItem(SESSION_CODE_KEY, code);
    return true;
  } catch {
    return false;
  }
}

function clearSessionCode() {
  try { sessionStorage.removeItem(SESSION_CODE_KEY); } catch { /* Storage may be unavailable. */ }
}

function restoreSession() {
  let code;
  try { code = sessionStorage.getItem(SESSION_CODE_KEY); } catch { return false; }
  if (!code) return false;
  if (!isValidCode(code)) { clearSessionCode(); return false; }
  void enterRoom(code);
  return true;
}

document.querySelector("#create-button").addEventListener("click", () => {
  showView(createView);
  generateCode();
});

document.querySelector("#open-join-button").addEventListener("click", () => {
  clearInputs();
  showView(joinView);
  joinCode.focus();
});

document.querySelectorAll("[data-home]").forEach((button) => {
  button.addEventListener("click", returnHome);
});

document.querySelector("#copy-button").addEventListener("click", async () => {
  if (!createdCode.value) return;
  try {
    await navigator.clipboard.writeText(createdCode.value);
    createFeedback.textContent = "코드를 복사했습니다.";
  } catch {
    createdCode.focus();
    createdCode.select();
    createFeedback.textContent = "복사에 실패했습니다. 선택된 코드를 직접 복사하세요.";
  }
});

document.querySelector("#save-button").addEventListener("click", () => {
  if (!createdCode.value) return;
  const url = URL.createObjectURL(new Blob([createdCode.value + "\n"], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "another-dimension-code.txt";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  createFeedback.textContent = "코드 파일을 안전한 곳에 보관하세요.";
});

document.querySelector("#created-join-button").addEventListener("click", async () => {
  if (!createdCode.value) return;
  if (await confirmActionDialog("방에 입장하시겠습니까?", "코드를 따로 보관하세요. 다시 보여드릴 수 없습니다.", "방 입장")) void enterRoom(createdCode.value);
});

document.querySelector("#join-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!isValidCode(joinCode.value.trim())) {
    joinCode.setAttribute("aria-invalid", "true");
    joinError.textContent = "올바른 입장 코드를 입력하세요.";
    return;
  }
  void enterRoom(joinCode.value.trim());
});

joinCode.addEventListener("input", () => {
  joinError.textContent = "";
  joinCode.removeAttribute("aria-invalid");
});

document.querySelector("#privacy-open").addEventListener("click", () => privacyDialog.showModal());
document.querySelector("#privacy-close").addEventListener("click", () => privacyDialog.close());

window.addEventListener("beforeunload", (event) => {
  if (codeVisible || messages.length > 0) event.preventDefault();
});

window.addEventListener("pagehide", () => {
  room?.close({ reason: "disconnect" });
  roomVersion++;
  room = null;
  messageInput.disabled = true;
  sendButton.disabled = true;
  for (const button of messagesElement.querySelectorAll(".retry-message")) button.disabled = true;
});

window.addEventListener("pageshow", (event) => {
  if (event.persisted && !room && !roomView.hidden && !restoreSession()) {
    roomStatus.textContent = "연결이 끊겼습니다";
    historyStatus.textContent = "방을 나간 후 코드를 다시 입력해 주세요.";
  }
});

restoreSession();


function formatTimestamp(time, includeDate = false) {
  const date = new Date(time);
  const pad = (value) => String(value).padStart(2, "0");
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return includeDate
    ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}:${pad(date.getSeconds())}`
    : clock;
}

function addMessage(message) {
  if (messageElements.has(message.id)) return false;
  if (!Number.isSafeInteger(message.at) || Math.abs(message.at) > 8640000000000000) message.at = Date.now();
  const low = messageInsertionIndex(messages, message);
  messages.splice(low, 0, message);
  const item = document.createElement("li");
  if (message.mine) item.classList.add("message-mine");
  const sender = document.createElement("span");
  sender.className = "visually-hidden";
  sender.textContent = message.mine ? "내가 보낸 메시지: " : "상대방이 보낸 메시지: ";
  const time = document.createElement("time");
  time.textContent = formatTimestamp(message.at);
  const text = document.createElement("p");
  text.textContent = message.text;
  item.append(sender, time, text);
  if (message.mine) {
    const receipt = document.createElement("span");
    receipt.className = "receipt";
    item.append(receipt);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "retry-message";
    retry.textContent = "다시 보내기";
    retry.addEventListener("click", () => {
      if (!room?.retryMessage(message)) {
        messageError.textContent = "메시지를 다시 보낼 수 없습니다.";
        return;
      }
      message.uncertain = false;
      messageError.textContent = "";
      renderReceipt(message);
    });
    item.append(retry);
  }
  messagesElement.insertBefore(item, messagesElement.children[low] || null);
  messageElements.set(message.id, item);
  if (message.mine) renderReceipt(message);
  messagesElement.scrollTop = messagesElement.scrollHeight;
  return true;
}

function restoreHistory(batch) {
  // A timestamp cutoff can discard valid messages when device clocks differ.
  for (const message of batch.messages) {
    const mine = !message.mine;
    if (mine && messageElements.has(message.id)) {
      room?.confirmPendingMessage(message.id);
      updateReceipt({ id: message.id, type: message.read ? "read" : "delivered" });
    } else {
      addMessage({ ...message, mine, read: mine && message.read === true, delivered: mine });
    }
  }
  markVisibleMessagesRead();
}

function receiveMessage(message) {
  const existing = messageElements.has(message.id);
  const previous = existing && messages.find((entry) => entry.id === message.id && !entry.mine);
  if (previous?.read) room?.sendRead(message.id);
  addMessage({ ...message, mine: false, read: false });
  if (!existing && messageElements.has(message.id)) {
    if (document.visibilityState !== "visible" || !document.hasFocus()) notifyMessage();
    markVisibleMessagesRead();
  }
  return messages.some((entry) => entry.id === message.id && !entry.mine);
}

function markVisibleMessagesRead() {
  if (!room || roomView.hidden || document.visibilityState !== "visible" || !document.hasFocus()) return;
  const unread = messages.filter((message) => !message.mine && !message.read);
  for (let offset = 0; offset < unread.length; offset += 20) {
    const batch = unread.slice(offset, offset + 20);
    if (room.sendReadBatch(batch.map((message) => message.id))) {
      for (const message of batch) message.read = true;
    }
  }
}

function renderReceipt(message) {
  const item = messageElements.get(message.id);
  if (!item) return;
  const label = item.querySelector(".receipt");
  const retry = item.querySelector(".retry-message");
  label.textContent = message.read ? "읽음" : (message.delivered ? "전달됨" : (message.uncertain ? "전달 여부 확인 불가" : "전달 확인 중"));
  retry.hidden = !message.uncertain || message.read || message.delivered;
  retry.disabled = sendButton.disabled;
}

function updateReceipt(receipt) {
  const message = messages.find((entry) => entry.id === receipt.id && entry.mine);
  if (!message) return;
  if (receipt.type === "read") message.read = true;
  if (receipt.type === "delivered") message.delivered = true;
  if (receipt.type === "uncertain" && !message.read && !message.delivered) message.uncertain = true;
  renderReceipt(message);
}

function updateNotificationButton() {
  notificationButton.hidden = !("Notification" in window) || Notification.permission !== "default";
}

async function notifyMessage() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const options = { body: "새 메시지가 도착했습니다." };
  try {
    if ("serviceWorker" in navigator) {
      notificationWorker ||= navigator.serviceWorker.register(new URL("../notification-worker.js", import.meta.url))
        .then(async (registration) => {
          if (registration.active) return registration;
          const ready = await navigator.serviceWorker.ready;
          if (ready.scope !== registration.scope) throw new Error("notification worker scope mismatch");
          return ready;
        });
      const registration = await notificationWorker;
      await registration.showNotification("Another Dimension", options);
    } else {
      new Notification("Another Dimension", options);
    }
  } catch {
    notificationWorker = null;
  }
}

notificationButton.addEventListener("click", async () => {
  try { await Notification.requestPermission(); } catch { /* Browser may not allow notifications. */ }
  updateNotificationButton();
});
updateNotificationButton();

document.addEventListener("visibilitychange", markVisibleMessagesRead);
window.addEventListener("focus", markVisibleMessagesRead);

messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = messageInput.value;
  if (!text.trim()) return;
  if (Array.from(text).length > 4000) {
    messageError.textContent = "메시지는 4,000자까지 입력할 수 있습니다.";
    return;
  }
  const at = Date.now();
  const message = room?.sendMessage(text, at);
  if (!message) {
    messageError.textContent = "메시지를 전송할 수 없습니다.";
    return;
  }
  addMessage({ ...message, mine: true });
  messageInput.value = "";
  messageError.textContent = "";
  messageInput.focus();
});

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && matchMedia("(pointer: fine)").matches) {
    event.preventDefault();
    messageForm.requestSubmit();
  }
});

document.querySelector("#save-chat-button").addEventListener("click", () => {
  const contents = messages.map((message) => `${formatTimestamp(message.at, true)} [${message.mine ? "나" : "상대방"}]: ${message.text}`).join("\n");
  const url = URL.createObjectURL(new Blob([contents], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "another-dimension-chat.txt";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
