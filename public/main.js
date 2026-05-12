const API_URL = "/chat";
const STORAGE_KEY = "chatHistory";
const SHOULD_PERSIST = true;
const MAX_HISTORY = 20;

// ── Semantic tone → color mapping ────────────────────────────────
const TONE_COLORS = {
  technical:   "#7dd3fc",
  creative:    "#d8b4fe",
  warning:     "#fcd34d",
  positive:    "#86efac",
  empathetic:  "#fda4af",
  curious:     "#fb923c",
  default:     "#c4bfff",
};

function classifyTone(text) {
  const t = text.toLowerCase();
  if (/```|`[^`]+`|\$[^$]+\$|\\frac|\\int|algorithm|function|variable|syntax|equation|formula|derivative|integral|python|javascript|css|html|api|debug|error:|exception/.test(t))
    return "technical";
  if (/\b(warning|caution|careful|danger|risk|important note|be aware|watch out|avoid|don't|cannot|invalid|mistake|wrong|incorrect|failed|failure)\b/.test(t))
    return "warning";
  if (/\b(great|excellent|perfect|well done|correct|you got it|exactly right|congrats|congratulations|nicely done|that's right|good job|absolutely|you're right)\b/.test(t))
    return "positive";
  if (/\b(i understand|i'm sorry|that sounds|how are you|feel free|don't worry|it's okay|totally normal|that must|i can imagine|take care|here for you)\b/.test(t))
    return "empathetic";
  if (/\b(poem|poetry|story|imagine|once upon|metaphor|rhyme|haiku|creative|narrative|character|fictional|fantasy|tale|sonnet|verse)\b/.test(t))
    return "creative";
  if (/\?/.test(t) && (t.match(/\?/g) || []).length >= 2)
    return "curious";
  return "default";
}

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
if (!SHOULD_PERSIST) localStorage.removeItem(STORAGE_KEY);

if (conversationHistory.length > 0) {
  if (emptyState) { emptyState.remove(); emptyState = null; }
  conversationHistory.forEach(entry => {
    const role = entry.role === "model" ? "ai" : "user";
    renderMessage(role, entry.parts[0].text, false);
  });
}

const scrollBtn = document.getElementById("scroll-btn");

chatContainer.addEventListener("scroll", () => {
  const atBottom =
    chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 80;
  scrollBtn.classList.toggle("visible", !atBottom);
});

scrollBtn.addEventListener("click", () => {
  chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: "smooth" });
});

// ── Math-safe markdown renderer ───────────────────────────────────
// Problem: marked.js escapes $ and \ before KaTeX can process them.
// Solution: extract all math/chem/science expressions → replace with
// unique placeholders → run marked → restore → run KaTeX.
//
// Supported syntaxes:
//   $$...$$          display math
//   $...$            inline math
//   \[...\]          display math (LaTeX style)
//   \(...\)          inline math (LaTeX style)
//   \ce{...}         chemistry  (mhchem)  e.g. \ce{H2SO4}, \ce{Fe^2+}
//   \pu{...}         physical units       e.g. \pu{6.022e23 mol-1}
//   \text{...}       text inside math
//   ^superscript     e.g. 10^{23}  (only inside $)
//   _subscript
//
function safeParse(raw) {
  const saved = [];

  function stash(str) {
    saved.push(str);
    return `\x02MATH${saved.length - 1}\x03`;
  }

  const protected_ = raw
    // 1. Fenced code blocks  — must go first so math inside code is not touched
    .replace(/```[\s\S]*?```/g, m => stash(m))
    .replace(/`[^`\n]+`/g, m => stash(m))

    // 2. Display math  $$...$$
    .replace(/\$\$[\s\S]+?\$\$/g, m => stash(m))

    // 3. Display math  \[...\]
    .replace(/\\\[[\s\S]+?\\\]/g, m => stash(m))

    // 4. Chemistry  \ce{...}  (wrap in $$ so KaTeX renders it)
    .replace(/\\ce\{[^}]*\}/g, m => stash(`$${m}$`))

    // 5. Physical units  \pu{...}
    .replace(/\\pu\{[^}]*\}/g, m => stash(`$${m}$`))

    // 6. Inline math  \(...\)
    .replace(/\\\([\s\S]+?\\\)/g, m => stash(m))

    // 7. Inline math  $...$  (single dollar — must not match $$)
    //    Allow multiline only up to 3 lines to avoid false positives
    .replace(/(?<!\$)\$(?!\$)([^\n$]{1,400}?)\$(?!\$)/g, m => stash(m));

  // Run markdown on the protected string
  let html = marked.parse(protected_);

  // Restore all stashed expressions (placeholders may be inside <p> tags)
  html = html.replace(/\x02MATH(\d+)\x03/g, (_, i) => saved[i]);

  return html;
}

// ── KaTeX render options (shared) ────────────────────────────────
const KATEX_OPTIONS = {
  delimiters: [
    { left: "$$",  right: "$$",  display: true  },
    { left: "$",   right: "$",   display: false },
    { left: "\\[", right: "\\]", display: true  },
    { left: "\\(", right: "\\)", display: false },
  ],
  // mhchem is loaded as a KaTeX extension via its CDN script;
  // it auto-registers \ce and \pu — no extra config needed here.
  macros: {
    // ── Physics / SI ──────────────────────────────────────────
    "\\hbar":      "\\hslash",           // reduced Planck (redundant but safe)
    "\\angstrom":  "\\text{Å}",
    "\\degree":    "^{\\circ}",
    "\\celcius":   "^{\\circ}\\text{C}",
    "\\kelvin":    "\\text{K}",

    // ── Biology / biochemistry ────────────────────────────────
    "\\DNA":       "\\text{DNA}",
    "\\RNA":       "\\text{RNA}",
    "\\ATP":       "\\text{ATP}",
    "\\ADP":       "\\text{ADP}",
    "\\pH":        "\\text{pH}",
    "\\Keq":       "K_{\\text{eq}}",
    "\\Km":        "K_m",
    "\\Vmax":      "V_{\\text{max}}",

    // ── Common math shorthands ────────────────────────────────
    "\\R":         "\\mathbb{R}",
    "\\N":         "\\mathbb{N}",
    "\\Z":         "\\mathbb{Z}",
    "\\C":         "\\mathbb{C}",
    "\\eps":       "\\varepsilon",
    "\\vp":        "\\varphi",
  },
  throwOnError: false,
  errorColor: "#ff6b6b",
};

// ── Code block copy buttons ───────────────────────────────────────
function addCodeCopyButtons(bubble) {
  bubble.querySelectorAll("pre").forEach(pre => {
    const wrapper = document.createElement("div");
    wrapper.className = "pre-wrapper";
    pre.replaceWith(wrapper);
    wrapper.appendChild(pre);

    const btn = document.createElement("button");
    btn.className = "code-copy-btn";
    btn.textContent = "copy";
    btn.onclick = async () => {
      const text = pre.querySelector("code")?.innerText ?? pre.innerText;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = "✓ copied";
        btn.classList.add("copied");
        setTimeout(() => { btn.textContent = "copy"; btn.classList.remove("copied"); }, 2000);
      } catch { btn.textContent = "failed"; }
    };
    wrapper.appendChild(btn);
  });
}

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

  if (role === "ai") {
    const color = TONE_COLORS[classifyTone(text)];
    bubble.style.color = color;
    bubble.style.setProperty("--tone-color", color);

    // Use safeParse to protect math/chem from marked's escaping
    bubble.innerHTML = safeParse(text);

    // Render all KaTeX expressions (math + \ce + \pu + macros)
    renderMathInElement(bubble, KATEX_OPTIONS);

    addCodeCopyButtons(bubble);
  } else {
    bubble.textContent = text;
  }

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

async function copyText(bubble, btn, rawText) {
  try {
    await navigator.clipboard.writeText(rawText);
    btn.textContent = "✓ copied";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = "📋 copy"; btn.classList.remove("copied"); }, 2000);
  } catch { btn.textContent = "failed"; }
}

// ── Regenerate last AI message ────────────────────────────────────
async function regenerate(aiMsgEl) {
  aiMsgEl.remove();
  const histIdx = conversationHistory.findLastIndex(e => e.role === "model");
  if (histIdx !== -1) conversationHistory = conversationHistory.slice(0, histIdx);
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
      body: JSON.stringify(body),
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

// ── Constellation background ──────────────────────────────────────
(function initBackground() {
  const canvas = document.getElementById("bg-canvas");
  const ctx = canvas.getContext("2d");

  const COUNT    = 85;
  const MAX_DIST = 135;
  const SPEED    = 0.28;
  const DOT_COLORS = ["196,181,253", "124,111,247", "255,255,255", "167,139,250"];

  let W, H, particles;

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  function spawn() {
    particles = Array.from({ length: COUNT }, () => ({
      x:  Math.random() * W,
      y:  Math.random() * H,
      vx: (Math.random() - 0.5) * SPEED,
      vy: (Math.random() - 0.5) * SPEED,
      r:  Math.random() * 1.4 + 0.4,
      c:  DOT_COLORS[Math.floor(Math.random() * DOT_COLORS.length)],
      o:  Math.random() * 0.35 + 0.15,
    }));
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    for (let i = 0; i < particles.length; i++) {
      const a = particles[i];
      for (let j = i + 1; j < particles.length; j++) {
        const b = particles[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < MAX_DIST) {
          ctx.beginPath();
          ctx.strokeStyle = `rgba(196,181,253,${(1 - dist / MAX_DIST) * 0.1})`;
          ctx.lineWidth = 0.5;
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
    for (const p of particles) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${p.c},${p.o})`;
      ctx.fill();
      p.x += p.vx; p.y += p.vy;
      if (p.x < -10) p.x = W + 10;
      if (p.x > W + 10) p.x = -10;
      if (p.y < -10) p.y = H + 10;
      if (p.y > H + 10) p.y = -10;
    }
    requestAnimationFrame(draw);
  }

  resize(); spawn(); draw();
  window.addEventListener("resize", () => { resize(); spawn(); });
})();

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
    <div class="empty-icon"></div>
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