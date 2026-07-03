# CaLISTo

A client-side cataloging and ranking application. Manage entities with images, rate them across graded features, assign weighted tags and custom fields, and compute composite scores — all in the browser with no server.

Built with vanilla JavaScript and [sql.js](https://sql.js.org/) (SQLite compiled to WebAssembly). Zero framework dependencies, no build step, no backend required.

## Features

- **Entity CRUD** — Create, edit, delete entities with names and images
- **Features/Grades** — Define weighted features and rate entities S/A/B/C/D/E/F
- **Tags** — Multi-select categorical labels with weight factors
- **Custom Fields** — Text, single-list, and multi-list fields with scoring
- **Scoring System** — Automatically computed weighted scores
- **Drag-and-Drop Import** — Drop image files to auto-create entities
- **Image Management** — Upload, replace, view in lightbox with prev/next/random navigation
- **Filtering & Sorting** — Real-time filtering by name, features, tags, custom fields; click-to-sort columns
- **Pagination** — Configurable rows per page (50/100/200/1000)
- **Export/Import** — Download and restore the full database as a `.sqlite` file
- **Compact Mode** — Toggle a condensed table view
- **Dark Theme** — Built-in dark UI

## Requirements

- A modern **Chromium-based browser** (Chrome, Edge, Opera) for the File System Access API
- Python 3 (for the local dev server)

## Getting Started

```bash
# Serve the app locally
./server.sh
```

Or manually:

```bash
python3 -m http.server 8000
# Open http://localhost:8000 in your browser
```

No install, no build, no package managers needed — just serve the directory.

## Usage

1. Open **Settings** (hamburger menu, top-left).
2. Click **Setup** to select an images folder and upload/download a `.sqlite` database.
3. Define **Features**, **Tags**, and **Custom Fields** from the sidebar.
4. Create entities by typing a name and clicking **Insert**, or drag-and-drop images onto the drop zone.
5. View and manage entities in the table — filter, sort, and edit inline.
6. Scores update automatically.

## Data Persistence

Data lives in browser memory (in-memory SQLite). To persist, **export your database** via the Settings menu before closing the page. Re-import it on your next session to restore data.

## Tech Stack

- **JavaScript (ES6+)** — No framework, pure vanilla
- **HTML5 / CSS3** — Dark theme, single-page layout
- **sql.js** — SQLite WebAssembly in the browser
- **File System Access API** — Local image read/write
