# BookOrbit Shelfmark Indexer Plugin

An indexer plugin for [BookOrbit](https://github.com/bookorbit/bookorbit) that integrates natively with a self-hosted [Shelfmark](https://github.com/calibrain/shelfmark) instance.

This plugin enables BookOrbit to search book releases across sources configured in Shelfmark (Anna's Archive, Libgen, etc.) and routes downloads through Shelfmark's download pipeline.

> [!NOTE]
> this is just fixes to make it work with my local setup.

---

## Features

- **Native BookOrbit Request Integration:** Fully compliant with BookOrbit's indexer plugin specification (`apiVersion: 1`). Searches and downloads are triggered through BookOrbit Requests on demand—no standalone background daemons and no continuous polling.
- **Duplicate Queue Protection & Task Adoption (v1.3.1):**
  - Pre-inspects Shelfmark's active, queued, and completed tasks before queueing.
  - Reuses completed downloads immediately after validating file presence via `/api/localdownload`, without re-downloading.
  - If a download is already in progress, safely adopts and monitors it without submitting a duplicate job.
  - Multi-tier adoption recovers from Shelfmark's `Release is already in the download queue` (500) error even when `source_id` is omitted by Shelfmark, correlating by title, format, and source.
  - **Single-Flight Concurrency with Independent Cancellation:** Multiple concurrent callers for the same release share a single background download worker. If one caller aborts, remaining callers continue uninterrupted. Settled state microtask desynchronization is eliminated.
  - **Historical Task Isolation:** Failed tasks from previous attempts are snapshotted and never contaminate newly observed downloads. Exact task IDs strictly override title matching.
  - **BookOrbit API Contract & Error Classification:** Replaced invalid `'cancelled'` failure codes with valid BookOrbit `PluginSearchFailure` codes (`timeout`, `error`). Strictly respects `PluginRequestInit` contract by never passing unsupported `signal` to `host.fetch()`.
  - **Search Optimization & Early Stopping:** Prioritizes best metadata matches and halts expensive provider queries once sufficient high-confidence releases are found, preventing search timeouts. Preserves validated releases if optional secondary queries fail.
- **Robust Metadata Search & Equivalence:**
  - Full compliance with BookOrbit v3.5.0's `PluginReleaseQuery` contract, supporting `isbn13` and `isbn13s` arrays.
  - Normalizes inverted author names with life dates (`"Orwell, George, 1903-1950"` → `"George Orwell"`), preventing zero-result failures on direct download providers like OceanofPDF and Anna's Archive.
  - Queries Shelfmark metadata by title only to circumvent Open Library's 0-result bug on combined queries.
  - Handles numeric titles safely (e.g., `1984`, `2001`, `451`) whether supplied as strings or numbers.
  - Supports confident bidirectional title equivalents (e.g., `"1984"` ↔ `"Nineteen Eighty-Four"`).
  - Cleans edition and subtitle noise (e.g. `"Animal Farm: A Fairy Story"`) when querying release indexers.
  - Implements bounded fallback searches: alternate titles, ISBN search, and direct `/api/releases` keyword queries when metadata providers return zero results.
  - Enforces strict author validation: rejects derivative adaptations by conflicting authors (e.g. Michael Dean adaptation of Orwell) and derivative study guides/summaries.
- **Accurate Release Metadata & Scoring Integrity:**
  - Emits authentic `isbn`, `sizeBytes`, `format`, and `language` without fabrication.
  - Aligns `bookTitle` with requested `searchTitle` so BookOrbit's title similarity scoring algorithm awards full title match score.
  - Never fabricates `freeleech: true` or artificial file counts.
  - Deduplicates identical releases across providers without collapsing distinct editions.
- **EPUB and PDF Support:** Prioritizes EPUB by default while fully supporting PDF downloads. (Audiobook support has been removed to streamline deployment).
- **Bounded Polling & Host Deadline Safety Margin:**
  - Polling occurs *only* while an individual download is active.
  - Reserves a 15-second safety margin below BookOrbit's outer timeout so the plugin returns a clean, informative error before BookOrbit cuts the connection.
  - Uses sensible exponential backoff (1s scaling up to 5s) and immediately aborts on BookOrbit `AbortSignal`.
- **Credential Protection:** Error messages and logs strictly redact API keys and sensitive query parameters.
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
│                │          3. Pre-check /api/status                 │
│                │ ─────────────────────────────────────────────────>│
│                │             (Adopt or Reuse if present)           │
│                │                                                   │
│                │          4. POST /api/releases/download           │
│                │ ─────────────────────────────────────────────────>│ 5. Downloads via
│                │                                                   │    Tor/Bypass/VPN
│                │          6. Bounded Polling (/api/status)         │
│                │ ─────────────────────────────────────────────────>│
│                │          7. GET /api/localdownload?id=...         ▼
│                │ <═══════════════════════════════════════════ [Local File]
└────────────────┘
```

1. **Search (`search`):** When a user searches in BookOrbit Requests:
   - Queries `/api/metadata/search` using the title only to avoid Open Library provider query drops.
   - Evaluates confident equivalents (`1984` ↔ `Nineteen Eighty-Four`) and ISBN fallback if empty.
   - Validates candidate title and author matches, rejecting unrelated works, derivative study guides, and summaries (`CliffsNotes`, `Summary of...`).
   - Normalizes inverted author names with life dates (`"Orwell, George, 1903-1950"` → `"George Orwell"`) to prevent search failures on direct providers.
   - Extracts ISBN (10 or 13 digits) and passes it to `/api/releases` for providers like Anna's Archive with direct ISBN indexes.
   - Fans out release queries across both core numeric titles and known equivalent text representations (capturing releases from both Anna's Archive and OceanofPDF).
   - Formats, deduplicates, and ranks releases (EPUB prioritized, then PDF; multi-format releases like `epub, pdf` recognized without dropping).
2. **Download Resolution (`resolveFile`):** When approved:
   - Inspects `/api/status` for matching active or completed tasks using strong release identifiers.
   - If an active task exists: adopts it and enters the polling loop without calling POST.
   - If a completed task exists: verifies that `/api/localdownload` can serve the file, then returns the URL immediately.
   - If no task exists: queues the download (`POST /api/releases/download`).
   - If POST returns `Release is already in the download queue` (500): refreshes status and adopts the matching task.
   - Polls `/api/status` with exponential backoff until complete, confirms file availability, and returns the URL to BookOrbit.

---

## Important System Considerations & Remaining Limitations

### 1. Duplicate Queue Retention in Shelfmark

**Shelfmark Architecture:**  
Shelfmark v1.5.1 tracks download tasks in an internal SQLite database (`app.db`). If a release has been queued, Shelfmark retains that release hash/ID across its active and completed history.  
- **If the file is intact:** The plugin detects the completed task, validates it, and reuses it immediately.
- **If the completed file was manually deleted from disk:** Shelfmark does not automatically notice the file deletion and will continue refusing new `POST` requests for that specific release with `{"error":"Release is already in the download queue"}`.
- **Remaining Limitation:** Shelfmark does not expose a selective API endpoint to purge single records from history. If a completed file was manually deleted from disk, the operator must clear the completed item from Shelfmark's Web UI (Queue/History) or choose an alternative release mirror/edition in BookOrbit.

---

### 2. Preventing Duplicate Imports (BookOrbit Book Dock vs Shelfmark)

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

### 3. Private Network SSRF Restriction (`ALLOW_PRIVATE`) & Core Limitations

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

### 4. Synchronous Plugin Resolution vs. Asynchronous Shelfmark Downloads

**The Architectural Trade-Off:**  
BookOrbit's plugin architecture treats `resolveFile` as a synchronous request-response call with an outer HTTP deadline (typically 240 seconds). Shelfmark, by contrast, is an asynchronous background task coordinator that queues downloads across web mirrors, Tor relays, or headless browser Cloudflare solvers that may take 5–15 minutes during peak times.
- **Safety Margin:** The plugin polls actively during the resolution window, reserving a 15-second safety margin below BookOrbit's host deadline so it can return cleanly with an informative message rather than letting the host cut the connection abruptly.
- **Background Persistence:** Even if BookOrbit's resolution request times out, Shelfmark continues downloading the task in the background. When the user or automatic queue re-attempts fulfillment later, the plugin detects the completed task, validates the local file via `/api/localdownload`, and adopts it instantly without re-downloading.

---

### 5. BookOrbit "View Files" Action & Idempotency

When an operator clicks "View files" in BookOrbit to inspect an approved release, BookOrbit may invoke `resolveFile` to preview the downloadable file:
- **Idempotent Inspection:** Because the plugin inspects `/api/status` before submitting any download, clicking "View files" will never queue duplicate downloads in Shelfmark if the file was already completed or is actively downloading.
- **Single-Flight Protection:** If multiple UI tabs or workers invoke `resolveFile` simultaneously for the same release, all callers subscribe to a single execution worker with independent cancellation.

---

### 4. Release Scoring

BookOrbit computes release scores using its internal scoring matrix (title match, author match, format priority, etc.).  
- The plugin reports factual release properties: exact format, title, author, size, seeders, leechers, and language.
- The plugin **does not** fabricate `freeleech: true` or false file counts to artificially inflate scores.
- BookOrbit owns the final scoring algorithm.

---

### 5. Update Ownership & Release Signing

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
     - **Download Wait Timeout (seconds):** Default is `240` (4 minutes).
   - Click **Test** to verify connection, then click **Save**.

---

## Verification & Testing

The repository includes a comprehensive, dependency-free local test suite with mocked BookOrbit host helpers and Shelfmark API fixtures:

```bash
npm test
```

### Test Coverage Highlights:
- **Contract & Metadata:** `apiVersion: 1`, Ed25519 signature verification against public key, and settings fields validation.
- **Search Robustness:** Exact matching, numeric titles (`1984`), digit-to-word equivalents (`1984` ↔ `Nineteen Eighty-Four`), numeric primitive safety, edition and subtitle handling (`Animal Farm`), direct release fallback, ISBN search, and author validation.
- **Queue Management & Adoption:** Existing active task adoption, completed task file validation and reuse, duplicate queue HTTP 500 recovery, missing disk file detection, in-flight concurrent deduplication, and retry adoption after abort.
- **Safety & Error Handling:** Ambiguous task rejection, missing task ID matching, timeout handling, error redaction of API keys, and AbortSignal cancellation.

---

## License

MIT License. See [LICENSE](LICENSE) for details.
