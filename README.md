# BookOrbit Shelfmark Indexer Plugin

An indexer plugin for [BookOrbit](https://github.com/bookorbit/bookorbit) that integrates with a self-hosted [Shelfmark](https://github.com/calibrain/shelfmark) instance. Yep, fully vibecoded.

It enables BookOrbit to search book releases across sources configured in Shelfmark (Anna's Archive, Libgen, etc.) and routes downloads through Shelfmark's download pipeline.

## Features

- **Native BookOrbit Integration:** Fully compliant with BookOrbit's indexer plugin specification (`apiVersion: 1`).
- **E-Book & Audiobook Support:** Seamlessly queries Shelfmark for both books (`ebook`) and audiobooks (`audiobook`), matching format priorities (`epub`, `mobi`, `azw3`, `pdf`, `m4b`, `mp3`).
- **Configurable via Web UI:** Set the Shelfmark URL, API Key, format preferences, and download timeouts directly inside BookOrbit's settings panel.
- **Dual Download Modes:**
  - **Shelfmark Managed (Recommended):** Queues download inside Shelfmark so any configured Tor/WireGuard/Cloudflare bypass runs inside Shelfmark, then serves the completed book to BookOrbit via `/api/localdownload`.
  - **Direct Download:** For sources that provide direct HTTP download links, BookOrbit can fetch the file directly.
- **Signed Auto-Updates:** Built-in Ed25519 cryptographic update channel for one-click and automatic updates directly from the BookOrbit UI.
- **Dependency-Free:** Single-file ECMAScript module (`index.mjs`) with zero third-party dependencies, running safely in BookOrbit's Node.js runtime.

## Prerequisites & Configuration Tweaks

### 1. Shelfmark Configuration
A fresh Shelfmark installation requires a few settings before searches can work:

* **Enable a Metadata Provider:**  
  Shelfmark has no internal catalog; it resolves book metadata externally. By default, no free provider is enabled.  
  1. Open Shelfmark Web UI (`http://shelfmark:8084`).
  2. Go to **Settings > Open Library** and check **Enable Open Library**.
  3. Go to **Settings > Search Mode** and ensure **Book Metadata Provider** is set to **Open Library**.  
  *(Without this, Shelfmark will return `HTTP 503: No metadata provider configured`).*

* **Configure Release Sources & Mirrors:**
  - **Libgen (Fastest, ~1s):** Go to **Settings > Libgen Search** and check **Enable Libgen Search**. In **Settings > Mirrors**, set **LibGen** mirrors to `https://libgen.li` and `https://libgen.gs` (mirrors like `.is` or `.rs` may be blocked by regional ISPs). *(Note: Libgen provides e-books only).*
  - **Anna's Archive (Direct Download):** In **Settings > Mirrors**, pin **Primary Mirror** (`AA_BASE_URL`) to `https://annas-archive.pk` instead of `auto` to avoid losing 15 seconds on failing mirrors like `.gl`.
  - **Audiobooks (AudiobookBay / Prowlarr):** For audiobook requests, enable **Settings > AudiobookBay** (`ABB_ENABLED=true`, `ABB_HOSTNAME=audiobookbay.lu`) or configure Prowlarr indexers under the Audiobook category (`3030`).
  - **Keep Challenge Solver Warm:** In **Settings > Cloudflare Bypass**, set **Bypasser Idle Timeout** (`BYPASS_BROWSER_IDLE_TIMEOUT`) to `1800` (30 minutes). This prevents Shelfmark from terminating its headless browser helper after 3 minutes of inactivity.

* **API Key:**
  Generate a key (`openssl rand -base64 32`) and pass it to your Shelfmark container environment:
  ```yaml
  environment:
    - SHELFMARK_API_KEY=your_generated_secret_key
  ```

---

### 2. BookOrbit Tweaks (Timeout & Local Network Downloads)

By default, BookOrbit enforces two constraints in its container that require adjustments when integrating with a self-hosted Shelfmark:

1. **Indexer Timeout (20 seconds):**  
   BookOrbit enforces a hardcoded timeout (`REQUEST_TIMEOUT_MS = 25_000` / `perIndexerTimeoutSeconds = 20`) on standalone indexer plugins.  
   - If searching **Libgen only**, queries take ~1–2 seconds and work out of the box.  
   - If searching **Anna's Archive**, solving the Cloudflare / DDoS-Guard challenge via Shelfmark's headless browser takes 25–45 seconds. BookOrbit will abort with `Shelfmark did not answer in time` unless this timeout is raised.

2. **Private Address SSRF Block (`ALLOW_PRIVATE = false`):**  
   BookOrbit's download client (`DirectDownloadService`) rejects any download URL that resolves to a private LAN or Docker IP (`PrivateAddressException`). Because Shelfmark delivers the downloaded book via its local API (`/api/localdownload`), BookOrbit will block the transfer unless private IPs are permitted.

To apply both fixes automatically at container startup, add this command override to your BookOrbit service in `compose.yaml`:

```yaml
services:
  bookorbit:
    image: ghcr.io/bookorbit/bookorbit:latest
    command:
      - sh
      - -c
      - |
        sed -i 's/REQUEST_TIMEOUT_MS = 25_000/REQUEST_TIMEOUT_MS = 180_000/g' /app/dist/modules/book-request/indexers/plugins/plugin-host.js 2>/dev/null || true
        sed -i 's/perIndexerTimeoutSeconds ?? 20/perIndexerTimeoutSeconds ?? 180/g' /app/dist/modules/book-request/indexers/indexer-config.service.js /app/dist/modules/book-request/indexers/indexer-search.service.js 2>/dev/null || true
        sed -i 's/const ALLOW_PRIVATE = false;/const ALLOW_PRIVATE = true;/g' /app/dist/modules/book-request/fulfillment/direct-download.service.js 2>/dev/null || true
        exec sh /app/entrypoint.sh
```

---

## Installation

1. Copy `index.mjs` to your BookOrbit data volume:
   ```bash
   mkdir -p <BOOKORBIT_DATA>/plugins/indexers/shelfmark
   cp index.mjs <BOOKORBIT_DATA>/plugins/indexers/shelfmark/index.mjs
   ```
   *(In standard Docker setups, `<BOOKORBIT_DATA>` is the host path mounted to `/data` in the BookOrbit container).*

2. Restart your BookOrbit container:
   ```bash
   docker restart bookorbit
   ```

3. Configure the indexer in the BookOrbit Web UI:
   - Go to **Settings > System > Requests > Sources**.
   - Click **Add Indexer** and select **Shelfmark**.
   - Enter your configuration:
     - **Base URL:** The URL of your Shelfmark server (e.g. `http://shelfmark:8084` or `http://192.168.1.100:8084`).
     - **Shelfmark API Key:** The key configured in Shelfmark (`SHELFMARK_API_KEY`). Optional if Shelfmark authentication is disabled.
     - **Preferred Format:** Priority book format (`epub`, `mobi`, `pdf`, `azw3`, `m4b`, etc.).
     - **Release Source:** `all` (searches all configured sources), `libgen`, or `direct_download`.
     - **Download via Shelfmark:** Enabled by default (routes downloads through Shelfmark's queue).
     - **Download Wait Timeout:** Maximum time in seconds to wait for Shelfmark to finish downloading before timing out (default: `180`).
   - Click **Test** to verify connection, then click **Save**.


## How It Works

```
┌──────────────┐         1. Search query          ┌──────────────┐
│              │ ───────────────────────────────> │              │
│  BookOrbit   │                                  │  Shelfmark   │
│              │ <─────────────────────────────── │  (FastAPI /  │
│              │    2. Releases (format, size)    │    Flask)    │
│              │                                  └──────────────┘
│              │         3. POST /download               │
│              │ ───────────────────────────────────────>│ 4. Downloads via
│              │                                         │    Tor/Bypass/VPN
│              │         5. GET /api/localdownload       ▼
│              │ <════════════════════════════════ [Local File]
└──────────────┘
```

1. **Search (`search`):** BookOrbit sends title and author. The plugin queries `/api/metadata/search` and `/api/releases` on Shelfmark.
2. **Release Selection:** Matching releases are sorted by format preference and returned to BookOrbit's book request picker.
3. **Download (`resolveFile`):** When approved, the plugin triggers `POST /api/releases/download` in Shelfmark, polls `/api/status` until completed, and hands the streaming URL `/api/localdownload?id=...` to BookOrbit.

## License

MIT License. See [LICENSE](LICENSE) for details.

---

[![GitHub Downloads](https://img.shields.io/github/downloads/hateitwtf/bookorbit-plugin-shelfmark/total?style=flat-square&logo=github)](https://github.com/hateitwtf/bookorbit-plugin-shelfmark/releases)
