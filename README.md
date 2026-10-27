# BookOrbit Shelfmark Indexer Plugin

An indexer plugin for [BookOrbit](https://github.com/bookorbit/bookorbit) that integrates natively with a self-hosted [Shelfmark](https://github.com/calibrain/shelfmark) instance.

This plugin enables BookOrbit to search book releases across sources configured in Shelfmark (Anna's Archive, Libgen, etc.) and routes downloads through Shelfmark's download pipeline.

> [!NOTE]
> This is a maintained fork (`esreddy2/bookorbit-plugin-shelfmark`) with cryptographic ownership transferred away from the upstream author to prevent automated overwrites, along with improvements for title-only Open Library metadata queries, strict author validation, safe missing task ID resolution, bounded polling with backoff, and focused EPUB/PDF support.

---

## Features

- **Native BookOrbit Request Integration:** Fully compliant with BookOrbit's indexer plugin specification (`apiVersion: 1`). Searches and downloads are triggered through BookOrbit Requests on demand—no standalone background daemons and no continuous polling.
- **Robust Metadata Search & Author Validation:** Queries Shelfmark's Open Library metadata endpoint by title only (resolving the Open Library bug where combined title and author queries return zero results), then validates both title and author before fetching releases to prevent incorrect book selection.
- **EPUB and PDF Support:** Prioritizes EPUB by default while fully supporting PDF downloads. (Audiobook support has been removed to streamline deployment).
- **Safe Download Handling:** Accurately handles Shelfmark tasks even when Shelfmark accepts downloads without returning a task ID. Pre-existing completed tasks from earlier downloads are safely ignored, and ambiguous multi-task matches fail safely to avoid associating with the wrong book.
- **Bounded Polling with Backoff:** Replaces fixed sleep polling with responsive, bounded polling featuring exponential backoff (1s up to 5s) and immediate AbortSignal cancellation.
- **Fork Update Ownership:** Cryptographically detached from upstream update channels. Auto-updates check this fork's repository and verify against an independent Ed25519 keypair.
- **Zero Dependencies:** Single-file ECMAScript module (`index.mjs`) compatible with BookOrbit's Node.js plugin sandbox.

---

## Prerequisites & Shelfmark Configuration

Before configuring BookOrbit, verify the following settings inside your Shelfmark instance (`http://shelfmark:8084`):

1. **Enable Open Library Metadata Provider:**  
   - Go to **Settings > Open Library** and check **Enable Open Library**.  
   - In **Settings > Search Mode**, ensure **Book Metadata Provider** is set to **Open Library**.  
   *(If not configured, Shelfmark returns `HTTP 503: No metadata provider configured`).*

2. **Configure Release Sources & Mirrors:**
   - **Libgen:** In **Settings > Libgen Search**, enable Libgen. In **Settings > Mirrors**, set Libgen mirrors (e.g. `https://libgen.li`, `https://libgen.gs`).
   - **Anna's Archive:** In **Settings > Mirrors**, specify a responsive primary mirror (e.g. `https://annas-archive.pk`).
   - **Cloudflare Bypass:** If using Cloudflare-protected mirrors, set **Bypasser Idle Timeout** (`BYPASS_BROWSER_IDLE_TIMEOUT`) to `1800` (30 minutes) to keep the solver warm.

3. **API Key Authentication:**  
   If authentication is enabled on Shelfmark, supply `SHELFMARK_API_KEY` via container environment:
   ```yaml
   environment:
     - SHELFMARK_API_KEY=your_generated_secret_key
   ```

---

## Architecture & How It Works

```
┌────────────────┐          1. Search query (Title)          ┌────────────────┐
│                │ ────────────────────────────────────────> │                │
│   BookOrbit    │                                           │   Shelfmark    │
│  (Requests UI) │ <──────────────────────────────────────── │ (Open Library) │
│                │     2. Validates Title/Author & Releases  └────────────────┘
│                │                                                   │
│                │          3. POST /api/releases/download           │
│                │ ─────────────────────────────────────────────────>│ 4. Downloads via
│                │                                                   │    Tor/Bypass/VPN
│                │          5. Bounded Polling (/api/status)         │
│                │ ─────────────────────────────────────────────────>│
│                │          6. GET /api/localdownload?id=...         ▼
│                │ <═══════════════════════════════════════════ [Local File]
└────────────────┘
```

1. **Search (`search`):** When a user searches in BookOrbit Requests, the plugin queries `/api/metadata/search` using the title only, then validates title and author matches to ensure exact catalog alignment before requesting releases from `/api/releases`.
2. **Release Ranking:** EPUB releases are ranked first by default, followed by PDF releases. Other formats (mobi, azw3, audiobooks) are ignored.
3. **Download Handoff (`resolveFile`):** When a request is approved, the plugin triggers `POST /api/releases/download`, snapshots existing tasks, polls `/api/status` with backoff until completed, and hands the download URL (`/api/localdownload?id=...`) to BookOrbit.

---

## Important System Considerations

### 1. Preventing Duplicate Imports (BookOrbit Book Dock vs Shelfmark)

**The Problem:**  
Shelfmark saves completed files into its internal download folder (e.g., `/downloads`). BookOrbit has a file watcher feature called **Book Dock** that automatically ingests any file placed into its watched directory.  
If both containers share or mount the same directory on your host, a race condition occurs:
1. Shelfmark downloads the book to disk.
2. BookOrbit's Book Dock detects the file and starts importing it as an unmanaged drop-in.
3. Simultaneously, BookOrbit's Request fulfillment downloads the file via `/api/localdownload` over HTTP.
4. This results in duplicate books, metadata conflicts, or locked file errors.

**The Solution:**  
- **Keep directories completely separate:** Never point BookOrbit's Book Dock watch path to Shelfmark's download directory.
- The plugin transfers book files over HTTP via `/api/localdownload`. BookOrbit **does not require filesystem access** to Shelfmark's download directory.
- Use a dedicated, isolated directory or volume for Shelfmark's downloads (e.g., `shelfmark_downloads`), and keep BookOrbit's Book Dock directory (e.g., `bookdock_incoming`) separate and used only for manual file drop-ins.

---

### 2. Private Network SSRF Restriction (`ALLOW_PRIVATE`) & Core Limitations

**Upstream Limitation:**  
BookOrbit includes SSRF (Server-Side Request Forgery) protection inside `DirectDownloadService` (`server/src/modules/book-request/fulfillment/direct-download.service.ts`).  
Due to an upstream BookOrbit bug ([BookOrbit Issue #1381](https://github.com/bookorbit/bookorbit/issues/1381)), `DirectDownloadService` contains a hardcoded constant:
```typescript
const ALLOW_PRIVATE = false;
```
Even if an operator checks the **"Allow private address"** setting in BookOrbit's UI for the Shelfmark indexer, this setting is currently ignored by `DirectDownloadService` when fetching the completed file from internal Docker network addresses (such as `http://shelfmark:8084` or `http://192.168.x.x`), triggering a `PrivateAddressException` ("URL resolves to a private address").

**Why Global `sed` Patching is Inadvisable:**  
Previous documentation recommended running a startup `sed` script:
```bash
# NOT RECOMMENDED
sed -i 's/const ALLOW_PRIVATE = false;/const ALLOW_PRIVATE = true;/g' ...
```
Globally setting `ALLOW_PRIVATE = true` disables SSRF protection for **all** direct downloads across the entire BookOrbit instance, exposing local services, container networks, and cloud instance metadata (`169.254.169.254`) to potential exploits.

**Clean Architectural Workarounds:**
1. **Reverse Proxy with Public Hostname:** Route Shelfmark through an internal reverse proxy using a public hostname with valid certificates (or via Cloudflare Tunnel / tailnet) that does not trigger RFC1918 raw IP rejection.
2. **Direct Download Mode:** If your sources (e.g., certain mirrors) provide direct public HTTP download links, toggle **Download via Shelfmark** to `false` in settings so BookOrbit downloads directly from the source.
3. **Smallest Necessary Upstream Core Fix:**  
   The correct, secure resolution requires a minor patch in BookOrbit core:
   - In `direct-download.service.ts`, accept the indexer configuration's `allowPrivateAddress` flag (which is already read by `plugin-host.ts`) as a parameter in `download(url, options)`.
   - Pass `allowPrivate: options.allowPrivateAddress ?? false` into `ensureSafeUrl(...)`.
   - This restricts private IP access exclusively to indexers where the system administrator has explicitly enabled the toggle.

---

### 3. Download Monitoring & Webhook Investigation

We investigated whether Shelfmark provides webhook notifications, Server-Sent Events (SSE), or callbacks upon download completion.  
Shelfmark currently only exposes internal WebSockets for its own web UI and **does not offer an outbound webhook or callback mechanism**.

To provide efficient, safe monitoring without background daemons:
- **Temporary & Bounded:** Polling is active *only* during the lifecycle of an approved download in `resolveFile()`.
- **Sensible Backoff:** Polling starts at 1 second for fast providers (e.g. Libgen) and backs off exponentially (1.5x factor up to a 5-second ceiling) to minimize CPU and network overhead.
- **Immediate Cancellation:** Listens to BookOrbit's `AbortSignal` to immediately terminate pending sleeps and HTTP calls when a user cancels a request.

---

### 4. Update Ownership & Release Signing

This fork is owned and maintained by `esreddy2`. It is cryptographically configured so that BookOrbit will **never** overwrite it with releases from the original upstream repository.

- **Manifest URL:** Points to `https://raw.githubusercontent.com/esreddy2/bookorbit-plugin-shelfmark/main/updates/shelfmark.json`.
- **Signing Key:** Signed with an independent Ed25519 keypair.
- **Disabling Updates:** If you prefer to manage plugin updates entirely manually without update notifications in the BookOrbit UI, you can set `update: null` inside `index.mjs`.

To generate a new signed release after modifying `index.mjs`:
```bash
npm run release [optional-new-version]
```

---

## Installation & Deployment Notes

Follow these steps to deploy this plugin on an existing BookOrbit server:

1. **Copy `index.mjs` to BookOrbit's plugins directory:**
   ```bash
   # On the Docker host running BookOrbit:
   mkdir -p <BOOKORBIT_DATA>/plugins/indexers/shelfmark
   cp index.mjs <BOOKORBIT_DATA>/plugins/indexers/shelfmark/index.mjs
   ```
   *(Replace `<BOOKORBIT_DATA>` with your host mount for BookOrbit, typically `/var/lib/bookorbit` or `./bookorbit-data`).*

2. **Ensure permissions:**
   ```bash
   chmod 644 <BOOKORBIT_DATA>/plugins/indexers/shelfmark/index.mjs
   ```

3. **Restart the BookOrbit container:**
   ```bash
   docker restart bookorbit
   ```

4. **Configure the Indexer in BookOrbit Web UI:**
   - Log in to BookOrbit and navigate to **Settings > System > Requests > Sources**.
   - Click **Add Indexer** and select **Shelfmark**.
   - Configure the indexer settings:
     - **Base URL:** Shelfmark's base URL (e.g. `http://shelfmark:8084`).
     - **Shelfmark API Key:** The key configured in Shelfmark (`SHELFMARK_API_KEY`).
     - **Preferred Format:** `epub` (prioritizes EPUB over PDF).
     - **Release Source:** `all`, `libgen`, or `direct_download`.
     - **Download via Shelfmark:** `true` (recommended for bypass/VPN handling).
     - **Download Wait Timeout (seconds):** Default is `180` (3 minutes). Set to `300` if using slower VPN/Tor links.
   - Click **Test** to verify connection, then click **Save**.

---

## Verification & Testing

The repository includes a comprehensive, dependency-free local test suite with mocked BookOrbit host helpers and Shelfmark API fixtures:

```bash
npm test
```

### Test Coverage Highlights:
- **Declaration & Security:** Contract validation (`apiVersion: 1`), Ed25519 manifest signature verification, and update channel ownership.
- **Metadata Searching:** Title-only metadata search, author validation against single, multiple, and transposed authors, and rejection of mismatched books.
- **Format Handling:** Filtering and ranking of EPUB and PDF releases; dropping unsupported formats.
- **Safe Task Matching:** Missing task ID recovery by title/format, pre-existing task isolation, and safe abortion on ambiguous matches.
- **Resilience:** AbortSignal cancellation, status polling timeouts, authentication rejections (401/403), and transient network failure tolerance.

---

## License

MIT License. See [LICENSE](LICENSE) for details.
