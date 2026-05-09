const API_URL = "/chat";
const STORAGE_KEY = "chatHistory";
const SHOULD_PERSIST = true;
const MAX_HISTORY = 20;

const chatContainer = document.getElementById("chat-container");
const userInput = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");
const memoryBtn = document.getElementById("memory-toggle");

let emptyState = document.getElementById("empty-state");
let messageIdCounter = 0;
let conversationHistory = [];
let memoryEnabled = true;

// ── Init memory state ─────────────────────────────────────────────
const savedMemoryState = localStorage.getItem("memoryEnabled");
if (savedMemoryState !== null) {
  memoryEnabled = savedMemoryState === "true";
}

if (memoryEnabled) {
  memoryBtn.textContent = "Memory: ON";
  memoryBtn.classList.add("active");
} else {
  memoryBtn.textContent = "Memory: OFF";
  memoryBtn.classList.remove("active");
}

// ── LocalStorage helpers ──────────────────────────────────────────
function saveHistory() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(conversationHistory));
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function trimHistory() {
  if (conversationHistory.length > MAX_HISTORY) {
    conversationHistory = conversationHistory.slice(-MAX_HISTORY);
  }
}

// ── Restore saved messages on load ────────────────────────────────
conversationHistory = SHOULD_PERSIST ? loadHistory() : [];

if (!SHOULD_PERSIST) {
  localStorage.removeItem(STORAGE_KEY);
}

if (conversationHistory.length > 0) {
  if (emptyState) {
    emptyState.remove();
    emptyState = null;
  }
  conversationHistory.forEach(entry => {
    const role = entry.role === "model" ? "ai" : "user";
    const text = entry.parts[0].text;
    renderMessage(role, text, false);
  });
}

// ── Textarea auto-resize ──────────────────────────────────────────
userInput.addEventListener("input", () => {
  userInput.style.height = "auto";
  userInput.style.height = Math.min(userInput.scrollHeight, 140) + "px";
});

userInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

function sendSuggestion(btn) {
  userInput.value = btn.textContent;
  sendMessage();
}

// ── Render a message bubble ───────────────────────────────────────
function renderMessage(role, text, animate = true) {
  const messageId = messageIdCounter++;
  if (emptyState) { emptyState.remove(); emptyState = null; }

  const msg = document.createElement("div");
  msg.className = `msg ${role}`;
  msg.dataset.id = messageId;
  if (!animate) msg.style.animation = "none";

  const label = document.createElement("div");
  label.className = "msg-label";
  label.textContent = role === "user" ? "you" : "ai";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = role === "ai" ? marked.parse(text) : "";
  if (role === "user") bubble.textContent = text;

  msg.appendChild(label);
  msg.appendChild(bubble);

  const actions = document.createElement("div");
  actions.className = "msg-actions";

  const copyBtn = makeActionBtn("📋 copy", () => copyText(bubble, copyBtn, text));
  actions.appendChild(copyBtn);

  if (role === "ai") {
    const regenBtn = makeActionBtn("↺ regenerate", () => regenerate(msg));
    actions.appendChild(regenBtn);
  }

  msg.appendChild(actions);
  chatContainer.appendChild(msg);
  chatContainer.scrollTop = chatContainer.scrollHeight;
  return bubble;
}

function makeActionBtn(label, onClick) {
  const btn = document.createElement("button");
  btn.className = "action-btn";
  btn.textContent = label;
  btn.onclick = onClick;
  return btn;
}

// ── Copy to clipboard ─────────────────────────────────────────────
async function copyText(bubble, btn, rawText) {
  try {
    await navigator.clipboard.writeText(rawText);
    btn.textContent = "✓ copied";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = "📋 copy";
      btn.classList.remove("copied");
    }, 2000);
  } catch {
    btn.textContent = "failed";
  }
}

// ── Regenerate last AI message ────────────────────────────────────
async function regenerate(aiMsgEl) {
  aiMsgEl.remove();

  const histIdx = conversationHistory.findLastIndex(e => e.role === "model");
  if (histIdx !== -1) {
    conversationHistory = conversationHistory.slice(0, histIdx);
  }

  if (memoryEnabled) saveHistory();

  sendBtn.disabled = true;
  showTyping("ai");

  try {
    const payload = conversationHistory.length
      ? { contents: conversationHistory }
      : { contents: [] };

    const reply = await fetchWithRetry(payload);

    if (memoryEnabled) {
      conversationHistory.push({ role: "model", parts: [{ text: reply }] });
      trimHistory();
      saveHistory();
    }

    removeTyping();
    renderMessage("ai", reply);
  } catch (err) {
    removeTyping();
    renderMessage("ai", "⚠ " + err.message);
  } finally {
    sendBtn.disabled = false;
    userInput.focus();
  }
}

// ── Typing indicator ──────────────────────────────────────────────
function showTyping(statusText = "ai") {
  removeTyping();
  const msg = document.createElement("div");
  msg.className = "msg ai";
  msg.id = "typing";

  const label = document.createElement("div");
  label.className = "msg-label";
  label.id = "typing-label";
  label.textContent = statusText;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = `<div class="typing-indicator"><span></span><span></span><span></span></div>`;

  msg.appendChild(label);
  msg.appendChild(bubble);
  chatContainer.appendChild(msg);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function removeTyping() {
  document.getElementById("typing")?.remove();
}

function setTypingStatus(text) {
  const label = document.getElementById("typing-label");
  if (label) label.textContent = text;
}

// ── Fetch with retry (503/429 backoff) ────────────────────────────
async function fetchWithRetry(body, retries = 4) {
  if (!body.contents || body.contents.length === 0) {
    throw new Error("No conversation history sent to model.");
  }

  for (let attempt = 0; attempt < retries; attempt++) {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (data.error?.code === 503 || data.error?.code === 429) {
      if (attempt < retries - 1) {
        const delay = 1500 * Math.pow(2, attempt);
        setTypingStatus(`retrying in ${Math.round(delay / 1000)}s…`);
        await new Promise(res => setTimeout(res, delay));
        setTypingStatus("ai");
        continue;
      }
      throw new Error("Model is overloaded. Please try again in a moment.");
    }

    if (data.error) throw new Error(data.error.message || "API error");

    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!reply) throw new Error("Empty response from model.");
    return reply;
  }
}

// ── Send message ──────────────────────────────────────────────────
async function sendMessage() {
  const text = userInput.value.trim();
  if (!text) return;

  userInput.value = "";
  userInput.style.height = "auto";
  sendBtn.disabled = true;

  renderMessage("user", text);

  if (memoryEnabled) {
    conversationHistory.push({ role: "user", parts: [{ text }] });
    trimHistory();
    saveHistory();
  }

  showTyping("ai");

  try {
    const payload = memoryEnabled
      ? { contents: conversationHistory }
      : { contents: [{ role: "user", parts: [{ text }] }] };

    const reply = await fetchWithRetry(payload);

    if (memoryEnabled) {
      conversationHistory.push({ role: "model", parts: [{ text: reply }] });
      trimHistory();
      saveHistory();
    }

    removeTyping();
    renderMessage("ai", reply);
  } catch (err) {
    removeTyping();
    renderMessage("ai", "⚠ " + err.message);
  } finally {
    sendBtn.disabled = false;
    userInput.focus();
  }
}

// ── Clear chat ────────────────────────────────────────────────────
let toastTimeout;

function promptClear() {
  const toast = document.getElementById("toast");
  toast.classList.add("show");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(hideToast, 5000);
}

function hideToast() {
  document.getElementById("toast").classList.remove("show");
}

function toggleMemory() {
  memoryEnabled = !memoryEnabled;
  localStorage.setItem("memoryEnabled", memoryEnabled);

  if (memoryEnabled) {
    memoryBtn.textContent = "Memory: ON";
    memoryBtn.classList.add("active");
  } else {
    memoryBtn.textContent = "Memory: OFF";
    memoryBtn.classList.remove("active");
    conversationHistory = [];
    localStorage.removeItem(STORAGE_KEY);
  }
}

function clearChat() {
  hideToast();
  conversationHistory = [];
  localStorage.removeItem(STORAGE_KEY);
  chatContainer.innerHTML = "";

  const es = document.createElement("div");
  es.className = "empty-state";
  es.id = "empty-state";
  es.innerHTML = `
    <div class="empty-icon">✦</div>
    <h2>How can I help you?</h2>
    <p>Ask me anything.</p>
    <div class="suggestions">
      <button class="suggestion-chip" onclick="sendSuggestion(this)">Explain quantum computing</button>
      <button class="suggestion-chip" onclick="sendSuggestion(this)">Write a short poem</button>
      <button class="suggestion-chip" onclick="sendSuggestion(this)">Help me brainstorm ideas</button>
      <button class="suggestion-chip" onclick="sendSuggestion(this)">Teach me the ways to prompt correctly</button>
    </div>`;
  chatContainer.appendChild(es);
  if (emptyState) emptyState.remove();
  emptyState = es;
}