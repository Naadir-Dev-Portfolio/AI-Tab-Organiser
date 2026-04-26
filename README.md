# AI-Tab-Organiser

> Chrome extension that instantly groups all your open tabs into colour-coded categories using Claude or Gemini.

![AI-Tab-Organiser](repo-card.png)

Built by [Naadir](https://github.com/Naadir-Dev-Portfolio)

---

## Overview

Thirty tabs open and no idea where anything is? One click sends all your tab titles and URLs to Claude or Gemini, which decides the groups, names them, and assigns colours. The extension then applies Chrome's native tab-grouping API — no manual dragging required. Groups can be cleared and re-run any time.

---

## Features

- Reads all eligible tabs and sends them to Claude or Gemini for categorisation
- Applies Chrome tab groups with AI-suggested names and colour assignments
- Side-panel UI with platform toggle (Claude or Gemini), apply, and clear controls
- Live tab count updates as tabs are opened or closed
- Option to exclude pinned tabs from grouping
- Polls for the AI response automatically and retries on failure

---

## Tech Stack

`JavaScript` · `HTML` · `CSS` · `Chrome Extensions API (Manifest V3)` · `Chrome Tab Groups API`

---

## Setup

1. Clone or download this repo
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select this folder
5. Pin the extension and open the side panel to organise your current window

---

<sub>JavaScript · HTML · CSS</sub>
