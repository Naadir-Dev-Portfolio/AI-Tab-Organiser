'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const AI_URLS = {
  claude: 'https://claude.ai',
  gemini: 'https://gemini.google.com',
};

// Extra delay after tab "complete" before injecting (lets SPA render)
const INJECT_DELAY_MS = 3000;
// How often to poll for the AI response (ms)
const POLL_INTERVAL_MS = 2000;
// Max polls before giving up (~90s)
const MAX_POLLS = 45;

// Valid Chrome tab group colours
const VALID_COLORS = ['grey','blue','red','yellow','green','pink','purple','cyan','orange'];

// ─── State ────────────────────────────────────────────────────────────────────

let selectedPlatform = 'gemini';
let pendingGroupings  = null; // { groupings: [], tabs: [] }
let isRunning         = false;
let aiWindowId        = null; // so we can force-close on error
let appliedGroupIds   = [];   // Chrome tab group IDs we created (for ungroup)

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await refreshTabCount();
  bindEvents();
});

function bindEvents() {
  document.getElementById('organiseBtn').addEventListener('click', handleOrganise);
  document.getElementById('applyBtn').addEventListener('click', handleApply);
  document.getElementById('clearBtn').addEventListener('click', handleClearGroups);
  document.getElementById('retryBtn').addEventListener('click', resetToIdle);

  // Platform toggle
  document.querySelectorAll('.platform-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.platform-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedPlatform = btn.dataset.platform;
    });
  });

  // Refresh tab count when user switches back to the panel
  chrome.tabs.onActivated.addListener(refreshTabCount);
  chrome.tabs.onCreated.addListener(refreshTabCount);
  chrome.tabs.onRemoved.addListener(refreshTabCount);
}

// ─── Tab Count ────────────────────────────────────────────────────────────────

async function refreshTabCount() {
  const tabs = await getEligibleTabs();
  const el = document.getElementById('tabCount');
  el.textContent = `${tabs.length} tab${tabs.length !== 1 ? 's' : ''} ready`;
}

async function getEligibleTabs() {
  const excludePinned = document.getElementById('excludePinned').checked;
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const all = await chrome.tabs.query({ windowId: active.windowId });

  return all.filter(t =>
    t.url &&
    !t.url.startsWith('chrome://') &&
    !t.url.startsWith('chrome-extension://') &&
    !t.url.startsWith('about:') &&
    !t.url.startsWith('edge://') &&
    !(excludePinned && t.pinned)
  );
}

// ─── Main Orchestration ───────────────────────────────────────────────────────

async function handleOrganise() {
  if (isRunning) return;
  isRunning = true;

  document.getElementById('organiseBtn').disabled = true;
  document.getElementById('applyBtn').style.display = 'none';
  pendingGroupings = null;

  try {
    // 1. Gather tabs
    setProgress('Reading your tabs…', 0);
    showState('progress');

    const tabs = await getEligibleTabs();
    if (tabs.length < 2) {
      throw new Error('Need at least 2 tabs to organise. Try opening more pages first.');
    }

    // 2. Build prompt
    const tabList = tabs
      .map((t, i) => `${i}: ${t.title || 'Untitled'} | ${safeDomain(t.url)}`)
      .join('\n');
    const prompt = buildPrompt(tabList, tabs.length);

    // 3. Open AI in a minimised background window
    setProgress(`Opening ${platformLabel()} in the background…`, 10);
    const win = await chrome.windows.create({ url: AI_URLS[selectedPlatform], focused: false });
    aiWindowId = win.id;
    // Minimise immediately so it's out of the way
    await chrome.windows.update(win.id, { state: 'minimized' });
    const aiTabId = win.tabs[0].id;

    // 4. Wait for the page to fully load
    setProgress('Waiting for AI page to load…', 20);
    await waitForTabComplete(aiTabId);

    // 5. Inject the prompt (reuse same approach as AI Article Sender)
    setProgress('Sending your tabs to AI…', 35);
    await sleep(INJECT_DELAY_MS);
    await chrome.scripting.executeScript({
      target: { tabId: aiTabId },
      func:   injectPrompt,
      args:   [selectedPlatform, prompt],
    });

    // 6. Poll for the response
    setProgress('AI is thinking…', 50);
    const rawResponse = await pollForResponse(aiTabId, selectedPlatform);

    // 7. Close the AI window
    try { await chrome.windows.remove(win.id); } catch {}
    aiWindowId = null;

    if (!rawResponse) {
      throw new Error('No response received from AI. The page may have taken too long to respond.');
    }

    // 8. Parse groupings
    setProgress('Parsing response…', 90);
    const groupings = extractGroupings(rawResponse);

    if (!groupings || groupings.length === 0) {
      throw new Error(
        'Could not parse a valid JSON response from the AI.\n\nTip: try Claude — it follows JSON format instructions more reliably than Gemini.'
      );
    }

    // 9. Show preview
    pendingGroupings = { groupings, tabs };
    renderGroupings(groupings, tabs);
    showState('results');
    document.getElementById('applyBtn').style.display = 'block';
    showToast(`✓ ${groupings.length} groups proposed`);

  } catch (err) {
    // Force-close the AI window if still open
    if (aiWindowId) {
      try { await chrome.windows.remove(aiWindowId); } catch {}
      aiWindowId = null;
    }
    showError(err.message || 'Something went wrong.');
  } finally {
    isRunning = false;
    document.getElementById('organiseBtn').disabled = false;
  }
}

// ─── Apply Groups ─────────────────────────────────────────────────────────────

async function handleApply() {
  if (!pendingGroupings) return;
  const btn = document.getElementById('applyBtn');
  btn.disabled = true;
  btn.textContent = 'Applying…';

  try {
    const { groupings, tabs } = pendingGroupings;
    appliedGroupIds = [];

    for (const g of groupings) {
      const tabIds = (g.tabIndices || [])
        .map(i => tabs[i]?.id)
        .filter(Boolean);
      if (tabIds.length === 0) continue;

      const color = VALID_COLORS.includes(g.color) ? g.color : 'grey';

      const groupId = await chrome.tabs.group({ tabIds });
      await chrome.tabGroups.update(groupId, {
        title: g.group || 'Group',
        color,
      });
      appliedGroupIds.push(groupId);
    }

    showToast('✓ Tab groups applied!');
    btn.textContent = '✓ Applied';
    // Show the ungroup button now that groups exist
    document.getElementById('clearBtn').style.display = 'block';

  } catch (err) {
    showToast('✗ Failed to apply groups: ' + err.message);
    btn.disabled = false;
    btn.textContent = '✓ Apply Groups';
  }
}

// ─── Clear Groups ─────────────────────────────────────────────────────────────

async function handleClearGroups() {
  if (!appliedGroupIds.length) return;
  const btn = document.getElementById('clearBtn');
  btn.disabled = true;
  btn.textContent = 'Clearing…';

  try {
    for (const groupId of appliedGroupIds) {
      // Get all tabs in this group and ungroup them
      const tabs = await chrome.tabs.query({ groupId });
      if (tabs.length) {
        await chrome.tabs.ungroup(tabs.map(t => t.id));
      }
    }
    appliedGroupIds = [];
    btn.style.display = 'none';
    document.getElementById('applyBtn').style.display = 'none';
    showToast('✓ Tab groups cleared');
    resetToIdle();
  } catch (err) {
    showToast('✗ Could not clear groups: ' + err.message);
    btn.disabled = false;
    btn.textContent = '✕ Ungroup All';
  }
}

// ─── Prompt Builder ───────────────────────────────────────────────────────────

function buildPrompt(tabList, count) {
  return `You are a browser tab organisation assistant. I have ${count} open browser tabs.

Group them into logical categories based on their content and purpose.

CRITICAL: Respond with ONLY a valid JSON array. No explanation. No markdown. No code fences. Raw JSON only.

Required format:
[
  {"group": "Group Name", "color": "blue", "tabIndices": [0, 2, 5]},
  {"group": "Another Group", "color": "green", "tabIndices": [1, 3]}
]

Rules:
- Every tab index (0 to ${count - 1}) must appear in exactly one group
- Group names must be concise (2-4 words)
- Create between 2 and 8 groups
- Tabs that don't fit elsewhere go in a "Miscellaneous" group with color "grey"
- Use ONLY these colors: grey, blue, red, yellow, green, pink, purple, cyan, orange

TABS (index: title | domain):
${tabList}`;
}

// ─── Wait for Tab Load ────────────────────────────────────────────────────────

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Safety: resolve after 15s even if event never fires
    setTimeout(resolve, 15_000);
  });
}

// ─── Poll for AI Response ─────────────────────────────────────────────────────

async function pollForResponse(tabId, platform) {
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);

    // Update progress bar (50% → 88%)
    const pct = 50 + Math.round((i / MAX_POLLS) * 38);
    setProgress('AI is thinking…', pct);

    let result;
    try {
      [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func:   checkResponseReady,
        args:   [platform],
      });
    } catch {
      // Tab was closed or navigated — bail
      return null;
    }

    if (result?.result) return result.result;
  }
  return null;
}

// ─── In-Page: Check Response Ready ───────────────────────────────────────────
// Runs inside the AI platform tab. Returns the response text when stable,
// or null if still loading.

function checkResponseReady(platform) {
  if (platform === 'claude') {
    // Still generating if the Stop button is visible
    if (document.querySelector('button[aria-label="Stop"]')) return null;

    const msgs = document.querySelectorAll(
      '[data-testid="assistant-message"], .font-claude-message, [class*="assistant-message"]'
    );
    if (!msgs.length) return null;

    const text = msgs[msgs.length - 1].textContent.trim();
    return text.length > 10 ? text : null;
  }

  if (platform === 'gemini') {
    // Still generating if loading indicator present
    if (document.querySelector(
      '.loading-indicator, [aria-label="Loading"], model-response [aria-busy="true"]'
    )) return null;

    const msgs = document.querySelectorAll('model-response, .response-container');
    if (!msgs.length) return null;

    const text = msgs[msgs.length - 1].textContent.trim();
    return text.length > 10 ? text : null;
  }

  return null;
}

// ─── In-Page: Inject Prompt ───────────────────────────────────────────────────
// Serialised and executed inside the AI platform tab.

function injectPrompt(platform, promptText) {
  const MAX_RETRIES = 6;
  const RETRY_MS   = 1000;

  function attempt(n) {
    if (n > MAX_RETRIES) return;

    if (platform === 'claude') {
      const editor = document.querySelector(
        '.ProseMirror p, [data-placeholder*="help you"], [contenteditable="true"]'
      );
      if (!editor) { setTimeout(() => attempt(n + 1), RETRY_MS); return; }

      editor.focus();
      document.execCommand('insertText', false, promptText);
      ['input', 'change', 'keyup'].forEach(t =>
        editor.dispatchEvent(new Event(t, { bubbles: true }))
      );

      setTimeout(() => {
        const btn = document.querySelector(
          "button[aria-label='Send message'], button[data-testid='send-button']"
        );
        if (btn) {
          btn.removeAttribute('disabled'); btn.disabled = false;
          const opts = { bubbles: true, cancelable: true, view: window, buttons: 1 };
          ['mousedown', 'mouseup', 'click'].forEach(t => btn.dispatchEvent(new MouseEvent(t, opts)));
        } else {
          editor.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
          }));
        }
      }, 1200);
    }

    else if (platform === 'gemini') {
      const editor = document.querySelector('rich-textarea .ql-editor');
      if (!editor) { setTimeout(() => attempt(n + 1), RETRY_MS); return; }

      editor.focus();
      editor.innerText = promptText;
      ['input', 'change'].forEach(t => editor.dispatchEvent(new Event(t, { bubbles: true })));

      setTimeout(() => {
        editor.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
        }));
        const btn = document.querySelector('.send-button-container');
        if (btn) btn.click();
      }, 600);
    }
  }

  attempt(0);
}

// ─── Parse JSON Groupings ─────────────────────────────────────────────────────

function extractGroupings(text) {
  // 1. Direct parse
  try {
    const trimmed = text.trim();
    if (trimmed.startsWith('[')) return JSON.parse(trimmed);
  } catch {}

  // 2. Strip markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch {}
  }

  // 3. Find first JSON array anywhere in the text
  const arrayMatch = text.match(/\[[\s\S]*?\]/);
  if (arrayMatch) {
    try { return JSON.parse(arrayMatch[0]); } catch {}
  }

  // 4. More aggressive — find the largest [...] block
  const allMatches = [...text.matchAll(/\[[\s\S]*\]/g)];
  for (const m of allMatches.reverse()) {
    try { const parsed = JSON.parse(m[0]); if (Array.isArray(parsed)) return parsed; } catch {}
  }

  return null;
}

// ─── Render Groupings Preview ─────────────────────────────────────────────────

function renderGroupings(groupings, tabs) {
  const list = document.getElementById('groupList');
  list.innerHTML = groupings.map(g => {
    const color  = VALID_COLORS.includes(g.color) ? g.color : 'grey';
    const indices = g.tabIndices || [];
    const tabItems = indices.map(i => {
      const t = tabs[i];
      if (!t) return '';
      const favicon = `https://www.google.com/s2/favicons?domain=${safeDomain(t.url)}&sz=16`;
      return `
        <div class="group-tab-item">
          <img class="group-tab-favicon" src="${favicon}" alt="" onerror="this.style.display='none'">
          <span class="group-tab-title">${esc(t.title || 'Untitled')}</span>
        </div>`;
    }).join('');

    return `
      <li class="group-card">
        <div class="group-card-header">
          <div class="group-swatch swatch-${color}"></div>
          <span class="group-name">${esc(g.group || 'Group')}</span>
          <span class="group-tab-count">${indices.length} tab${indices.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="group-tab-list">${tabItems}</div>
      </li>`;
  }).join('');
}

// ─── UI State Helpers ─────────────────────────────────────────────────────────

function showState(state) {
  ['idleState', 'progressState', 'resultsState', 'errorState'].forEach(id => {
    document.getElementById(id).style.display = 'none';
  });
  const map = { idle: 'idleState', progress: 'progressState', results: 'resultsState', error: 'errorState' };
  if (map[state]) document.getElementById(map[state]).style.display =
    state === 'progress' ? 'flex' : state === 'idle' || state === 'error' ? 'flex' : 'block';
}

function setProgress(label, pct) {
  document.getElementById('progressLabel').textContent = label;
  document.getElementById('progressBar').style.width   = pct + '%';
  showState('progress');
}

function showError(msg) {
  document.getElementById('errorMsg').textContent = msg;
  showState('error');
}

function resetToIdle() {
  pendingGroupings = null;
  document.getElementById('applyBtn').style.display = 'none';
  showState('idle');
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function showToast(message) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const toast = document.createElement('div');
  toast.className   = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('toast--show')));
  setTimeout(() => {
    toast.classList.remove('toast--show');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, 3200);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function safeDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function platformLabel() {
  return { claude: 'Claude', gemini: 'Gemini' }[selectedPlatform] || selectedPlatform;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
