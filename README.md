# BookOrbit Shelfmark Indexer Plugin

An indexer plugin for [BookOrbit](https://github.com/bookorbit/bookorbit) that integrates with a self-hosted [Shelfmark](https://github.com/calibrain/shelfmark) instance.

It enables BookOrbit to search book releases across sources configured in Shelfmark (Anna's Archive, Libgen, etc.) and routes downloads through Shelfmark's download pipeline.

## Features

- **Native BookOrbit Integration:** Fully compliant with BookOrbit's indexer plugin specification (`apiVersion: 1`).
- **Configurable via Web UI:** Set the Shelfmark URL, API Key, and format preferences directly inside BookOrbit's settings panel.
- **Dual Download Modes:**
  - **Shelfmark Managed (Recommended):** Queues download inside Shelfmark so any configured Tor/WireGuard/Cloudflare bypass runs inside Shelfmark, then serves the completed book to BookOrbit via `/api/localdownload`.
  - **Direct Download:** For sources that provide direct HTTP download links, BookOrbit can fetch the file directly.
- **Dependency-Free:** Single-file ECMAScript module (`index.mjs`) with zero third-party dependencies, running safely in BookOrbit's Node.js runtime.

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
   - Go to **Settings > System > Requests > Indexers**.
   - Click **Add Indexer** and select **Shelfmark**.
   - Enter your configuration:
     - **Base URL:** The URL of your Shelfmark server (e.g. `http://shelfmark:8084` or `http://192.168.1.100:8084`).
     - **Shelfmark API Key:** The secret key configured in Shelfmark (`SHELFMARK_API_KEY`).
     - **Preferred Format:** Choose your preferred book format (`epub`, `mobi`, `pdf`, `azw3`).
     - **Download via Shelfmark:** Enabled by default.
   - Click **Test** to verify connection, then click **Save**.

## Testing & Verification

The repository includes an offline test harness validating connectivity, search transformations, and download resolution:

```bash
node verify.mjs
```

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
