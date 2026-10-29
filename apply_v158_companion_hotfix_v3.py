#!/usr/bin/env python3
"""Companion v1.5.8 recovery safety patch v3 (source-structure aware).

Usage (as normal repo owner; no sudo):
  python3 apply_v158_companion_hotfix_v3.py --check
  python3 apply_v158_companion_hotfix_v3.py

Changes only bridge/bridge.mjs and verify.mjs. Does not execute deployment operations, reset state,
modify index.mjs, sign a manifest, or touch server credentials.
"""
import argparse
import difflib
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import tempfile

LOOKUP = "  /**\n   * Read actual BookOrbit v3.5.0 library book cards without inventing GET routes.\n   * A failed, truncated or unauthorized query is UNKNOWN, never an empty library.\n   */\n  async listAuthoritativeBookOrbitBooks(task, targetLibraryId, headers, fetchFn = globalThis.fetch) {\n    const libraryId = parsePositiveInt(targetLibraryId);\n    const title = String(task?.bookTitle || task?.title || '').trim();\n    if (!libraryId || !title || title.length > 200) return null;\n    const url = `${this.bookorbitUrl}/api/v1/libraries/${libraryId}/books`;\n    const size = 100;\n    const all = [];\n    try {\n      for (let page = 0; page < 5; page++) {\n        const result = await fetchFn(url, {\n          method: 'POST',\n          headers: { ...headers, 'Content-Type': 'application/json' },\n          body: JSON.stringify({ q: title, sort: [], pagination: { page, size } }),\n        });\n        if (!result?.ok) return null;\n        const data = await result.json();\n        if (!data || !Array.isArray(data.items)) return null;\n        all.push(...data.items);\n        const total = Number(data.total);\n        // A shortened page when total says more results remain is not full evidence.\n        if (Number.isFinite(total) && total >= 0) {\n          if (all.length >= total) return all;\n          if (data.items.length < size) return null;\n        } else if (data.items.length < size) {\n          return all;\n        }\n      }\n    } catch (err) {\n      console.warn(`[Bridge] Library lookup unavailable: ${sanitizeLog(err?.message || err)}`);\n    }\n    // A >500-match query is not complete evidence. Fail closed rather than guess.\n    return null;\n  }\n\n  /**\n   * Only adopt one uniquely identified, edition-compatible BookOrbit library book.\n   * For an uncertain upload, prefer a NEW id absent from the pre-upload snapshot.\n   * Without a snapshot, require a matching publication year or ISBN; title alone\n   * is not proof of the correct edition (especially for multiple Frankenstein editions).\n   */\n  async findAuthoritativeBookOrbitBook(task, targetLibraryId, headers, fetchFn = globalThis.fetch, mode = 'conflict') {\n    const cards = await this.listAuthoritativeBookOrbitBooks(task, targetLibraryId, headers, fetchFn);\n    if (!cards) return null;\n    const baselineKnown = task?.uploadBaselineChecked === true && Array.isArray(task.uploadBaselineIds);\n    const beforeIds = new Set(baselineKnown ? task.uploadBaselineIds.map(Number) : []);\n    const opf = String(task?.filePath || '').toLowerCase().endsWith('.epub')\n      ? extractEpubMetadataFromFile(task.filePath) : null;\n    const expectedYear = parsePositiveInt(task?.year || task?.publishedYear || task?.publicationYear || opf?.year);\n    const expectedIsbn = String(task?.isbn13 || task?.isbn || task?.extra?.isbn || opf?.isbn || '')\n      .replace(/[^0-9X]/gi, '');\n    const expectedAuthor = String(task?.author || (Array.isArray(task?.authors) ? task.authors[0] : '') || opf?.author || '').trim();\n    const matched = new Map();\n    for (const card of cards) {\n      const id = parsePositiveInt(card?.id ?? card?.bookId);\n      if (!id) continue;\n      const authors = Array.isArray(card.authors) ? card.authors : [];\n      const author = typeof card.author === 'string' && card.author.trim()\n        ? card.author : (typeof authors[0] === 'string' ? authors[0] : authors[0]?.name || '');\n      const formats = Array.isArray(card.formats)\n        ? card.formats.map((f) => typeof f === 'string' ? f.toLowerCase() : String(f?.format || '').toLowerCase()) : [];\n      const wantedFormat = String(task?.format || '').toLowerCase();\n      const primaryFormat = String(card.primaryFormat || card.format || '').toLowerCase();\n      if (wantedFormat && ((formats.length && !formats.includes(wantedFormat)) ||\n          (!formats.length && primaryFormat && primaryFormat !== wantedFormat))) continue;\n      const book = {\n        ...card, id, author: String(author).trim(),\n        year: card.year || card.publishedYear || card.publicationYear || null,\n        isbn: card.isbn13 || card.isbn || null,\n        format: wantedFormat && formats.includes(wantedFormat) ? wantedFormat : primaryFormat,\n      };\n      // Both explicit title and author are required: missing metadata is not identity.\n      if (!String(book.title || '').trim() || !expectedAuthor || !book.author) continue;\n      if (!areEditionsCompatible({ ...task, author: expectedAuthor }, book)) continue;\n      const observedYear = parsePositiveInt(book.year);\n      const observedIsbn = String(book.isbn || '').replace(/[^0-9X]/gi, '');\n      const editionVerified = Boolean(\n        (expectedIsbn && observedIsbn && expectedIsbn === observedIsbn) ||\n        (expectedYear && observedYear && expectedYear === observedYear)\n      );\n      const newlyImported = baselineKnown && !beforeIds.has(id);\n      if (mode === 'uncertain' && baselineKnown && !newlyImported) continue;\n      if (!newlyImported && !editionVerified) continue;\n      matched.set(id, book);\n    }\n    // Never pick the first of multiple plausible editions. Require unique identity.\n    return matched.size === 1 ? [...matched.values()][0] : null;\n  }\n"

PREFLIGHT = "    let matchedBookId = parsePositiveInt(task.matchedBookId) || null;\n    // A transient 401/403/network error is UNKNOWN, not evidence of cancellation.\n    // Never let a status outage mark a completed Shelfmark task permanently cancelled.\n    const activeRequestIds = [];\n    const unknownRequestIds = [];\n    let explicitlyCancelled = 0;\n    let alreadyAvailable = 0;\n    if (!task.requestFulfillments) task.requestFulfillments = {};\n    for (const rid of (task.requestIds || [])) {\n      // A prior successful fulfillment is durable proof; a later API outage must\n      // not overwrite it or cause a duplicate POST.\n      if (task.requestFulfillments[rid]?.fulfilled) {\n        alreadyAvailable++;\n        continue;\n      }\n      const ridState = await this.getRequestStatus(rid, fetchFn);\n      if (ridState === 'fulfilled') {\n        task.requestFulfillments[rid] = {\n          fulfilled: true, alreadyAvailable: true, fulfilledAt: new Date().toISOString(),\n        };\n        alreadyAvailable++;\n        this.setRequestProgress(rid, 'available', { reason: 'already_available' });\n      } else if (ridState === 'cancelled') {\n        explicitlyCancelled++;\n        task.requestFulfillments[rid] = {\n          fulfilled: false, errorType: 'cancelled', error: 'Request cancelled',\n          updatedAt: new Date().toISOString(),\n        };\n        this.setRequestProgress(rid, 'cancelled', { reason: 'cancelled' });\n      } else if (ridState === 'active') {\n        activeRequestIds.push(rid);\n      } else {\n        unknownRequestIds.push(rid);\n        task.requestFulfillments[rid] = {\n          fulfilled: false, errorType: 'status_unknown', error: 'Request status unknown',\n          updatedAt: new Date().toISOString(),\n        };\n        this.setRequestProgress(rid, 'status_unknown', { reason: 'status_unknown' });\n      }\n    }\n    this.saveState();\n    if ((task.requestIds || []).length > 0 && activeRequestIds.length === 0) {\n      if (unknownRequestIds.length > 0) {\n        // Keep completed/imported/uncertain_upload recoverable for reconciliation.\n        task.error = `BookOrbit request status temporarily unknown for ${unknownRequestIds.length} request(s)`;\n        this.saveState();\n        return { fulfilled: false, error: task.error };\n      }\n      task.fulfilledRequestIds = task.requestIds.filter((id) => task.requestFulfillments[id]?.fulfilled);\n      task.unfulfilledRequestIds = task.requestIds.filter((id) => !task.requestFulfillments[id]?.fulfilled);\n      task.status = explicitlyCancelled === task.requestIds.length ? 'cancelled'\n        : task.unfulfilledRequestIds.length ? 'partially_fulfilled' : 'fulfilled';\n      task.updatedAt = new Date().toISOString();\n      this.saveState();\n      return { fulfilled: task.status === 'fulfilled', count: alreadyAvailable,\n        bookId: matchedBookId, error: task.status === 'cancelled' ? 'All requests cancelled' : undefined };\n    }\n    for (const rid of activeRequestIds) {\n      this.setRequestProgress(rid, 'importing', { reason: 'importing' });\n    }\n\n"

STEP2 = "    for (const reqId of task.requestIds) {\n      if (task.requestFulfillments[reqId]?.fulfilled) {\n        fulfilledCount++;\n        continue;\n      }\n      const step2State = await this.getRequestStatus(reqId, fetchFn);\n      if (step2State === 'fulfilled') {\n        task.requestFulfillments[reqId] = {\n          fulfilled: true, alreadyAvailable: true, fulfilledAt: new Date().toISOString(),\n        };\n        fulfilledCount++;\n        this.saveState();\n        continue;\n      }\n      if (step2State === 'cancelled') {\n        task.requestFulfillments[reqId] = {\n          fulfilled: false,\n          errorType: 'cancelled',\n          error: 'Request cancelled',\n          updatedAt: new Date().toISOString(),\n        };\n        this.setRequestProgress(reqId, 'cancelled', { reason: 'cancelled' });\n        this.saveState();\n        continue;\n      }\n      if (step2State !== 'active') {\n        task.requestFulfillments[reqId] = {\n          fulfilled: false,\n          errorType: 'status_unknown',\n          error: 'Request status unknown',\n          updatedAt: new Date().toISOString(),\n        };\n        this.setRequestProgress(reqId, 'status_unknown', { reason: 'status_unknown' });\n        this.saveState();\n        continue;\n      }\n"

RECONCILE_GUARD = "          // Only skip when every request is VERIFIED terminated/settled.\n          // UNKNOWN is a temporary state and must remain eligible for a future retry.\n          const activeIds = [];\n          const unknownIds = [];\n          for (const rid of (task.requestIds || [])) {\n            if (task.requestFulfillments?.[rid]?.fulfilled) continue;\n            const st = await this.getRequestStatus(rid, fetchFn);\n            if (st === 'active') activeIds.push(rid);\n            else if (st !== 'cancelled' && st !== 'fulfilled') unknownIds.push(rid);\n          }\n          if ((task.requestIds || []).length > 0 && activeIds.length === 0 && unknownIds.length === 0) {\n            // Terminal requests; nothing to upload or retry.\n            continue;\n          }\n          if (activeIds.length === 0) {\n            // The only unresolved requests cannot currently be checked. Keep task as-is.\n            continue;\n          }\n"


def require(cond, description):
    if not cond:
        raise ValueError(description)


def region(text, method, next_method):
    a = list(re.finditer(r'(?m)^  async ' + re.escape(method) + r'\(', text))
    b = list(re.finditer(r'(?m)^  (?:async )?' + re.escape(next_method) + r'\(', text))
    require(len(a) == 1 and len(b) == 1 and a[0].start() < b[0].start(),
            f'{method}: method boundary changed. Found {len(a)} start / {len(b)} next markers. Aborting safely.')
    return a[0].start(), b[0].start()


def scope_replace(text, method, next_method, replacement_fn):
    a, b = region(text, method, next_method)
    original = text[a:b]
    replaced = replacement_fn(original)
    require(replaced != original, f'{method}: no modification detected (already fixed or changed source)')
    return text[:a] + replaced + text[b:]


def patch_status(src):
    old = "if (status === 'cancelled' || status === 'canceled' || status === 'rejected' || status === 'available') return 'cancelled';"
    new = "if (status === 'cancelled' || status === 'canceled' || status === 'rejected') return 'cancelled';"
    occurrences = src.count(old)
    require(occurrences in (0,2), f'Request status parsing changed: found {occurrences} old cancelled/available branches; require 0 or 2')
    src = src.replace(old, new)
    old2 = "if (!status) return 'active';"
    occurrences2 = src.count(old2)
    require(occurrences2 in (0,2), f'Request status empty-state branches changed: {occurrences2}')
    src = src.replace(old2, "if (!status) return 'unknown';")
    require(src.count(new) == 2 and src.count("if (!status) return 'unknown';") == 2,
            'Request status invariants failed: expected corrected classification in both single and list lookup')
    return src


def patch_lookup(original):
    require('findAuthoritativeBookOrbitBook' in original, 'Expected BookOrbit library lookup missing')
    require('async listAuthoritativeBookOrbitBooks' not in original,
            'Library lookup already modified: refusing to replace custom implementation')
    # The last comment belongs to uploadDirectToLibrary; keep it with updated section.
    return LOOKUP + """  /**
   * Uploads file directly into BookOrbit Library:
   * POST /api/v1/libraries/:id/upload?folderId=:folderId
   * Accepts multipart/form-data with file field "file".
   */
"""


def exact_or_already(src, old, new, label):
    n = src.count(old)
    if n == 1:
        return src.replace(old, new, 1)
    if n == 0 and src.count(new) == 1:
        return src
    raise ValueError(f'{label}: neither a unique old nor unique corrected call exists (old={n}, corrected={src.count(new)})')


def patch_upload_scope(part):
    # Update failure handling for a 2xx upload missing an actual ID.
    marker = re.compile(r'(?ms)^      if \(!bookId\) \{\n(?P<body>(?:.*?\n){1,5}?)^      \}', re.M)
    hits = list(marker.finditer(part))
    require(len(hits) == 1, f'2xx upload ID guard changed: {len(hits)} found')
    body = hits[0].group('body')
    if 'networkError: true' in body:
        return part  # already corrected
    require('notFound: true' in body, '2xx missing-ID handling changed; do not guess')
    new = "      if (!bookId) {\n        // A 2xx response without book ID is an uncertain upload, not a missing route.\n        return { networkError: true, error: 'Upload succeeded but returned no usable book ID' };\n      }"
    return part[:hits[0].start()] + new + part[hits[0].end():]


def patch_preflight(part):
    # Find the END of the authentication headers object rather than assuming any
    # particular preceding comment, blank line, or legacy preflight condition.
    headers = list(re.finditer(r'(?ms)^    const headers = \{\n.*?^    \};\n', part))
    step = list(re.finditer(r'(?m)^    // Step 1: Import file into Library', part))
    require(len(headers) == 1 and len(step) == 1 and headers[0].end() < step[0].start(),
            f'Fulfillment method structure unrecognized (headers={len(headers)}, step1={len(step)}). No files changed.')
    a, b = headers[0].end(), step[0].start()
    body = part[a:b]
    require(len(body) < 6000 and ('activeRequestIds' in body or 'unknownRequestIds' in body)
            and ('matchedBookId' in body),
            'Unexpected fulfillment preflight; refusing to overwrite unknown local modifications')
    return part[:a] + PREFLIGHT + part[b:]


def patch_fulfillment(part):
    part = patch_preflight(part)
    old = 'const authoritativeBook = await this.findAuthoritativeBookOrbitBook(task, targetLibraryId, headers, fetchFn);'
    newer = "const authoritativeBook = await this.findAuthoritativeBookOrbitBook(task, targetLibraryId, headers, fetchFn, 'conflict');"
    # This call is in uploadDirectToLibrary, not the fulfillment method.
    old = 'const resolved = await this.findAuthoritativeBookOrbitBook(task, targetLibraryId, headers, fetchFn);'
    newer = "const resolved = await this.findAuthoritativeBookOrbitBook(task, targetLibraryId, headers, fetchFn, 'uncertain');"
    part = exact_or_already(part, old, newer, 'uncertain upload lookup')
    if 'task.uploadBaselineChecked' not in part:
        m = list(re.finditer(r'(?m)^(?P<indent>[ ]*)directResult\s*=\s*await this\.uploadDirectToLibrary\(task, targetLibraryId, targetFolderId, headers, fetchFn\);',part))
        require(len(m) == 1, f'Direct upload site changed: {len(m)} found')
        indent = m[0].group('indent')
        before = """// Capture a read-only baseline before any potentially non-idempotent POST.
if (task.uploadBaselineChecked !== true) {
  const before = await this.listAuthoritativeBookOrbitBooks(task, targetLibraryId, headers, fetchFn);
  if (before !== null) {
    task.uploadBaselineChecked = true;
    task.uploadBaselineIds = before.map((b) => parsePositiveInt(b?.id ?? b?.bookId)).filter(Boolean);
    this.saveState();
  }
}
"""
        addition = ''.join(indent + line + '\n' for line in before.rstrip('\n').split('\n'))
        part = part[:m[0].start()] + addition + part[m[0].start():]
    # The new branch preserves prior success before status rechecks.
    m_start=list(re.finditer(r'(?m)^    let fulfilledCount = 0;\n', part))
    m_end=list(re.finditer(r'(?m)^      try \{\n        const fulfillDto = \{', part))
    require(len(m_start)==1 and len(m_end)==1 and m_start[0].end() < m_end[0].start(),
            f'Per-request fulfillment loop changed (count={len(m_start)}, dto={len(m_end)}). No files changed')
    middle=part[m_start[0].end():m_end[0].start()]
    require('task.requestFulfillments' in middle and len(middle)<6000, 'Unexpected fulfillment-loop logic, refusing to overwrite')
    part=part[:m_start[0].end()] + STEP2 + part[m_end[0].start():]
    return part


def patch_reconcile(part):
    # Scope the guard to the completed-task branch by selecting the last activeIds
    # declaration before the matchedBookId retry. No dependency on exact comments.
    a = list(re.finditer(r'(?m)^          const activeIds = \[\];\n', part))
    b = list(re.finditer(r'(?m)^          if \(task\.matchedBookId\) \{', part))
    require(len(a) == 1 and len(b) == 1 and a[0].end() < b[0].start(),
            f'Reconciliation guard changed (activeIds={len(a)}, matchedBookId={len(b)}). No files changed.')
    mid = part[a[0].start():b[0].start()]
    require(('getRequestStatus' in mid or 'unknownIds' in mid) and len(mid)<3500,
            'Unexpected completed-task retry logic; refusing destructive replacement')
    return part[:a[0].start()] + RECONCILE_GUARD + part[b[0].start():]


def transform(src):
    src = patch_status(src)
    src = scope_replace(src,'findAuthoritativeBookOrbitBook','uploadDirectToLibrary',patch_lookup)
    src = scope_replace(src,'uploadDirectToLibrary','uploadViaBookDock',patch_upload_scope)
    src = exact_or_already(src,
          'const authoritativeBook = await this.findAuthoritativeBookOrbitBook(task, targetLibraryId, headers, fetchFn);',
          "const authoritativeBook = await this.findAuthoritativeBookOrbitBook(task, targetLibraryId, headers, fetchFn, 'conflict');",
          '409 library lookup')
    src = scope_replace(src,'_fulfillBookOrbitRequestsImpl','reconcile',patch_fulfillment)
    src = scope_replace(src,'reconcile','startReconciliation',patch_reconcile)
    require('const unknownRequestIds = []' in src and 'listAuthoritativeBookOrbitBooks' in src
            and "'uncertain'" in src, 'Patch outcome invariants failed')
    return src



def patch_verify(text):
    """Teach strict black-box tests the REAL v3.5.0 library route and Available status."""
    if "['bo.libraryBooks'" not in text:
        matches = list(re.finditer(r"(?m)^  \['bo.upload',[^\n]+\n", text))
        require(len(matches) == 1, f'verify.mjs known-API allowlist changed: {len(matches)} bo.upload markers')
        m = matches[0]
        text = text[:m.end()] + r"  ['bo.libraryBooks', 'POST', /^\/api\/v1\/libraries\/[1-9]\d*\/books\/?$/]," + "\n" + text[m.end():]
    if "'bo.libraryBooks':" not in text:
        needle="    'bo.upload': (entry) => { onPost(entry); return response(onUpload(entry)); },"
        require(text.count(needle) == 1, 'verify.mjs API fixture handler changed; no files changed')
        text=text.replace(needle, needle+"\n    'bo.libraryBooks': () => response({ items: [], total: 0 }),")
    bad="for (const state of ['cancelled', 'rejected', 'available']) {"
    good="for (const state of ['cancelled', 'rejected']) {"
    if bad in text:
        require(text.count(bad)==1,'verify.mjs cancellation state loop duplicated')
        text=text.replace(bad, good)
    require(good in text,'verify.mjs cancellation loop changed; do not guess')
    target="test('CANCEL: a 403 from individual lookup can fall back to the supported admin LIST', async () => {"
    if "CANCEL: Available is fulfilled, never cancelled" not in text:
        require(text.count(target)==1,'verify.mjs cancellation fallback test marker changed')
        addition="""test('CANCEL: Available is fulfilled, never cancelled', async () => {
  const bridge = new BridgeService(bridgeOpts());
  const fake = apiScenarios({ details: { 'already-available': request('already-available', 'Animal Farm', 'George Orwell', { status: 'available' }) } });
  assert.equal(await bridge.getRequestStatus('already-available', fake.fetch), 'fulfilled');
  fake.assertKnownRoutes();
});
"""
        text=text.replace(target,addition+target,1)
    return text

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--check', action='store_true', help='Dry run: check all structural edits and Node syntax; do not write')
    ap.add_argument('repo', nargs='?', default='.', help='Repo directory')
    args=ap.parse_args()
    root=pathlib.Path(args.repo).resolve()
    bridge=root/'bridge'/'bridge.mjs'
    if not bridge.is_file() or not (root/'verify.mjs').exists():
        ap.error('Must run from repo root containing bridge/bridge.mjs and verify.mjs')
    pkg=json.loads((root/'package.json').read_text())
    manifest=json.loads((root/'updates'/'shelfmark.json').read_text())
    if pkg.get('version') != '1.5.8' or manifest.get('version') != '1.5.8':
        ap.error('Not a v1.5.8 checkout; no changes made')
    if hashlib.sha256((root/'index.mjs').read_bytes()).hexdigest()!=manifest.get('sha256'):
        ap.error('index.mjs SHA256 mismatches signed native-plugin manifest; no changes made')
    verify=root/'verify.mjs'
    old_verify=verify.read_text(encoding='utf-8')
    old=bridge.read_text(encoding='utf-8')
    if '// v158-recovery-hotfix-v3' in old:
        ap.error('v3 patch already applied; no changes made')
    try:
        new=transform(old)
        new_verify=patch_verify(old_verify)
    except ValueError as e:
        ap.error(f'{e}. Please compare the local bridge.mjs against the published v1.5.8 revision; no files changed.')
    # Add durable marker outside JS execution and test with Node before modifying repo.
    new='// v158-recovery-hotfix-v3 (companion-only; BookOrbit v3.5.0 API contract)\n'+new
    with tempfile.TemporaryDirectory(prefix='bo-v158-v3-') as td:
        temp=pathlib.Path(td)/'bridge.mjs'
        temp.write_text(new,encoding='utf-8')
        checked=subprocess.run(['node','--check',str(temp)],text=True,capture_output=True)
        if checked.returncode:
            ap.error('Patched bridge did not pass Node syntax: '+checked.stderr.strip()+'. No files changed')
        vtemp=pathlib.Path(td)/'verify.mjs'
        vtemp.write_text(new_verify, encoding='utf-8')
        vchecked=subprocess.run(['node','--check',str(vtemp)],text=True,capture_output=True)
        if vchecked.returncode:
            ap.error('Patched verify.mjs failed syntax check: '+vchecked.stderr.strip()+'. No files changed')
    diff=list(difflib.unified_diff(old.splitlines(),new.splitlines(),lineterm=''))
    print('PASS: v1.5.8 bridge+verification source structure and Node syntax checked; signed plugin/manifest untouched')
    print(f'bridge/bridge.mjs: +{sum(x.startswith("+") and not x.startswith("+++") for x in diff)} / -{sum(x.startswith("-") and not x.startswith("---") for x in diff)} lines')
    print('verify.mjs: '+str(len(new_verify.splitlines()) - len(old_verify.splitlines()))+' net new lines')
    if args.check:
        print('DRY-RUN ONLY: nothing written. Re-run without --check to apply.')
        return 0
    backup=root/'.git'/'bookorbit-v158-v3-original-bridge.mjs'
    backup_verify=root/'.git'/'bookorbit-v158-v3-original-verify.mjs'
    if backup.exists() or backup_verify.exists():
        ap.error('v3 backup exists; refusing to overwrite either source file')
    if (root/'.git').is_dir():
        backup.write_text(old,encoding='utf-8')
        backup_verify.write_text(old_verify,encoding='utf-8')
    else:
        ap.error('Repo .git missing, refusing to overwrite without safe backup')
    try:
        bridge.write_text(new, encoding='utf-8')
        verify.write_text(new_verify, encoding='utf-8')
    except OSError:
        # A partial write must not leave the repo with only half the patch.
        bridge.write_text(old, encoding='utf-8')
        verify.write_text(old_verify, encoding='utf-8')
        raise
    print('PASS: updated bridge/bridge.mjs and verify.mjs; originals backed up inside .git.')
    print('NEXT: npm test && git diff --check (also run the supplied node --test regression file).')
    return 0

if __name__=='__main__':
    sys.exit(main())
