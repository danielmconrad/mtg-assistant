// /upload: the upload page, from a signed link get_upload_link made. Cloudflare Access guards the route,
// and the Access identity must be the link's user. Choosing a file previews it: the raw file goes to the
// private R2 bucket and a row in uploads, and the page lists what would change. Nothing is applied until
// the person confirms that preview, which works once and carries its own CSRF token. Applying replans
// from the stored file, guarded on the collection's revision at preview, so it applies exactly what the
// preview showed or nothing.
import { verifyAccess } from './auth/access.mjs';
import { logAuthEvent } from './auth/users.mjs';
import { collectionChanges, decksNaming } from './core/collection-diff.mjs';
import { parseCollection } from './core/collection.mjs';
import { isActiveDeck } from './core/deck.mjs';
import { errorPage, escapeHtml, htmlPage } from './http.mjs';
import { LinkKeyMissing, useLink, verifyLink } from './links.mjs';
import { resolvedRows, targetCollection } from './mcp/tools/collection-writes.mjs';
import { ToolError } from './mcp/tools/shared.mjs';
import { cardIndexFor, loadCardRows } from './storage/cards.mjs';
import { applyCollectionChanges, entriesFor, planAdd, sourceRecords } from './storage/collection-writes.mjs';

export const UPLOAD_PURPOSE = 'upload';
export const UPLOAD_TTL_MS = 10 * 60 * 1000;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
// Each preview uses the link once, so a wrong file or setting can be fixed; each preview applies once.
export const MAX_UPLOAD_PREVIEWS = 3;
export const UPLOAD_MODES = ['merge', 'replace'];
const PREVIEW_TTL_MS = 30 * 60 * 1000;
// Room for the form's other fields and the multipart boundaries around the file.
const FORM_OVERHEAD_BYTES = 64 * 1024;
const FORMATS = { csv: 'manabox_csv', txt: 'text' };
const CHANGES_SHOWN = 200;
const PROBLEMS_SHOWN = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CSRF = /^[A-Za-z0-9_-]{43}$/;

// A problem with the file or the choices on the form, shown on the page.
class UploadProblem extends Error {}

const asProblem = (error) => {
  if (error instanceof ToolError) return new UploadProblem(error.message);
  return error;
};

const randomToken = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

// The file's rows: a ManaBox CSV's with their other columns kept for exports, or a text list's, each
// matched to a printing or card. Rows the card data doesn't know are refused, as add_cards refuses them.
async function uploadedRows(db, text, { format, fileName }) {
  if (format === 'text') {
    try {
      return (await resolvedRows(db, text, fileName)).rows;
    } catch (error) {
      throw asProblem(error);
    }
  }
  let rows;
  let records;
  try {
    rows = parseCollection(text, fileName);
    records = sourceRecords(text);
  } catch (error) {
    throw new UploadProblem(error.message);
  }
  const { index } = await cardIndexFor(db, await loadCardRows(db, { printingIds: rows.map((row) => row.scryfallId) }));
  const unknown = rows.filter((row) => !index.byId.has(row.scryfallId));
  if (unknown.length) {
    throw new UploadProblem(
      unknown
        .slice(0, PROBLEMS_SHOWN)
        .map(
          (row) =>
            `${fileName}: record ${row.position + 2}: ${row.name} has a Scryfall ID the card data doesn't have yet`,
        )
        .join('\n'),
    );
  }
  return rows.map((row) => ({ ...row, sourceRecord: records[row.position] }));
}

// Replacing a collection deletes its rows and writes the file's in its order.
const replacement = (entries, rows) => ({
  updates: new Map(),
  deletes: entries.map((entry) => entry.id),
  inserts: rows.map((row, position) => ({
    position,
    name: row.name,
    quantity: row.quantity,
    scryfall_id: row.scryfallId,
    set_code: row.set ?? null,
    collector_number: row.collectorNumber ?? null,
    finish: row.finish,
    is_proxy: row.isProxy ? 1 : 0,
    in_deck_binder: row.inDeckBinder ? 1 : 0,
    source_record: row.sourceRecord ?? null,
  })),
});

// A replacement's log entries: the net change per printing and finish, not every row rewritten.
function netEvents(entries, rows) {
  const net = new Map();
  const count = (name, scryfallId, finish, change) => {
    const key = `${scryfallId}|${finish}|${name}`;
    const event = net.get(key) ?? { name, scryfallId, finish, change: 0 };
    event.change += change;
    net.set(key, event);
  };
  for (const entry of entries) count(entry.name, entry.scryfall_id, entry.finish, -entry.quantity);
  for (const row of rows) count(row.name, row.scryfallId, row.finish, row.quantity);
  return [...net.values()].filter((event) => event.change);
}

// What an upload does to its collection: the change applyCollectionChanges writes, and the per-card
// differences and decks naming them, for the page.
async function planUpload(db, userId, upload, text, now) {
  const rows = await uploadedRows(db, text, { format: upload.format, fileName: upload.file_name });
  let target;
  try {
    target = await targetCollection(db, userId, upload.collection_name, { create: true, now, format: upload.format });
  } catch (error) {
    throw asProblem(error);
  }
  const { collection, decks } = target;
  const entries = collection.isNew ? [] : await entriesFor(db, userId, collection.id);
  const merge = upload.mode === 'merge';
  const plan = merge ? planAdd(entries, rows) : replacement(entries, rows);
  const events = merge
    ? rows.map((row) => ({ name: row.name, scryfallId: row.scryfallId, finish: row.finish, change: row.quantity }))
    : netEvents(entries, rows);
  const before = new Map(collection.isNew ? [] : [[collection.name, entries]]);
  const changes = collectionChanges(before, new Map([[collection.name, merge ? [...entries, ...rows] : rows]]));
  const format = !merge && !collection.isNew && collection.format !== upload.format ? upload.format : undefined;
  return {
    collection,
    change: { collection, plan, events, format },
    cards: changes[0]?.cards ?? [],
    decks: decksNaming(
      changes,
      decks.filter(({ deck }) => isActiveDeck(deck)),
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Pages. Everything from the request, the file or the person's data is escaped.

const lines = (text) => escapeHtml(text).replace(/\n/g, '<br>');

function formPage(email, token, { collection = '', mode = 'merge', problem } = {}) {
  const option = (value, label) =>
    `<label><input type="radio" name="mode" value="${value}"${mode === value ? ' checked' : ''}> ${label}</label><br>`;
  return htmlPage(
    'Upload to a binder',
    `<h1>Upload to a binder</h1>
<p>Signed in through Cloudflare Access as <strong>${escapeHtml(email)}</strong>.</p>
${problem ? `<p class="warn">${lines(problem)}</p>` : ''}
<form method="post" action="/upload" enctype="multipart/form-data">
  <input type="hidden" name="step" value="preview">
  <input type="hidden" name="token" value="${escapeHtml(token)}">
  <p><label>A ManaBox CSV export (.csv) or a text list (.txt), 5 MB at most<br>
    <input type="file" name="file" accept=".csv,.txt" required></label></p>
  <p><label>Binder (a new name starts a new one)<br>
    <input name="collection" value="${escapeHtml(collection)}" maxlength="120" required></label></p>
  <p>${option('merge', 'Merge: add the file’s cards to the binder')}${option('replace', 'Replace: the binder becomes exactly the file')}</p>
  <p><button>Preview</button></p>
</form>`,
    { status: problem ? 400 : 200 },
  );
}

function previewPage(upload, { collection, cards, decks }) {
  const signed = ({ name, change }) => `${change > 0 ? '+' : ''}${change} ${name}`;
  const shown = cards.slice(0, CHANGES_SHOWN).map((card) => `<li>${escapeHtml(signed(card))}</li>`);
  const more = cards.length > CHANGES_SHOWN ? `<li>and ${cards.length - CHANGES_SHOWN} more</li>` : '';
  const verb = upload.mode === 'merge' ? 'Merge' : 'Replace';
  const protectedNote = collection.protected
    ? '<p class="warn">This binder is protected: its cards are reported but never supply a deck.</p>'
    : '';
  return htmlPage(
    'Upload preview',
    `<h1>${verb} ${escapeHtml(collection.name)}${collection.isNew ? ' (new)' : ''}?</h1>
<p>From ${escapeHtml(upload.file_name)}. ${cards.length ? `${cards.length} cards change:` : 'Nothing would change.'}</p>
${cards.length ? `<ul>${shown.join('')}${more}</ul>` : ''}
${decks.length ? `<p>Decks naming changed cards: ${escapeHtml(decks.map(({ deck, cards: named }) => `${deck} (${named.join(', ')})`).join('; '))}</p>` : ''}
${protectedNote}
<form method="post" action="/upload">
  <input type="hidden" name="upload" value="${escapeHtml(upload.id)}">
  <input type="hidden" name="csrf" value="${escapeHtml(upload.csrf)}">
  <p><button name="step" value="approve">Apply</button><button name="step" value="discard">Discard</button></p>
</form>
<p>The preview lasts 30 minutes, and nothing changes until you apply it.</p>`,
  );
}

const donePage = (title, message) => htmlPage(title, `<h1>${escapeHtml(title)}</h1><p>${lines(message)}</p>`);

// ---------------------------------------------------------------------------------------------
// Steps.

const REFUSED = 'This upload link is invalid, expired or used up. Ask Claude for a new one.';

// The link's claims when it's valid and made for this person, or the reason it isn't.
async function linkFor(env, user, token, now) {
  const verified = await verifyLink(env.UPLOAD_SIGNING_KEY, UPLOAD_PURPOSE, token, now);
  if (verified.problem) return verified;
  if (verified.claims.user !== user.id) return { problem: 'signed-in person is not the link’s user' };
  return verified;
}

// The uploaded file's text and format: a .csv or .txt file of UTF-8 text, 5 MB at most.
async function fileText(file) {
  if (!(file instanceof File) || !file.size) throw new UploadProblem('Choose a file.');
  if (file.size > MAX_UPLOAD_BYTES) throw new UploadProblem('Files must be 5 MB or less.');
  const extension = /\.(csv|txt)$/i.exec(file.name)?.[1].toLowerCase();
  if (!extension) throw new UploadProblem('Upload a .csv (ManaBox export) or .txt (text list) file.');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    throw new UploadProblem('That file isn’t text (UTF-8).');
  }
  if (text.includes('\0')) throw new UploadProblem('That file isn’t text.');
  return { text, format: FORMATS[extension] };
}

async function preview(request, env, { user, form, now, refuse }) {
  const token = String(form.get('token') ?? '');
  const link = await linkFor(env, user, token, now);
  if (link.problem) return refuse(link.problem);
  if (!(await useLink(env.DB, link.claims, MAX_UPLOAD_PREVIEWS, now))) return refuse('used up');
  const collection = String(form.get('collection') ?? '').trim();
  const mode = UPLOAD_MODES.includes(form.get('mode')) ? form.get('mode') : 'merge';
  const file = form.get('file');
  const upload = { id: crypto.randomUUID(), collection_name: collection, mode, csrf: randomToken() };
  let text;
  let planned;
  try {
    if (!collection || collection.length > 120) throw new UploadProblem('Name the binder.');
    ({ text, format: upload.format } = await fileText(file));
    upload.file_name = file.name.slice(-120);
    planned = await planUpload(env.DB, user.id, upload, text, now);
  } catch (error) {
    if (error instanceof UploadProblem) {
      return formPage(user.email, token, { collection, mode, problem: error.message });
    }
    throw error;
  }
  const rawKey = `uploads/${user.id}/${upload.id}`;
  await env.UPLOADS.put(rawKey, text, {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    customMetadata: { collection, mode, format: upload.format },
  });
  const { collection: target } = planned;
  await env.DB.prepare(
    `INSERT INTO uploads (id, user_id, collection_name, mode, format, file_name, size, raw_key, csrf, base_revision,
       created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      upload.id,
      user.id,
      collection,
      mode,
      upload.format,
      upload.file_name,
      file.size,
      rawKey,
      upload.csrf,
      target.isNew ? null : (target.revision ?? ''),
      new Date(now).toISOString(),
      now + PREVIEW_TTL_MS,
    )
    .run();
  await logAuthEvent(env.DB, request, 'upload_previewed', {
    email: user.email,
    detail: { mode, format: upload.format, size: file.size, new: Boolean(target.isNew) },
  });
  return previewPage(upload, planned);
}

// Claims a pending preview for this person: the CSRF token must match, and only one request can move it
// out of pending.
async function claimUpload(db, user, form, status, now) {
  const id = String(form.get('upload') ?? '');
  const csrf = String(form.get('csrf') ?? '');
  if (!UUID.test(id) || !CSRF.test(csrf)) return null;
  const claimed = await db
    .prepare(
      `UPDATE uploads SET status = ? WHERE id = ? AND user_id = ? AND csrf = ? AND status = 'pending' AND expires_at > ?
       RETURNING *`,
    )
    .bind(status, id, user.id, csrf, now)
    .first();
  return claimed;
}

async function discard(request, env, { user, form, now, refuse }) {
  const upload = await claimUpload(env.DB, user, form, 'discarded', now);
  if (!upload) return refuse('preview not pending', 'That preview has expired or was already used.');
  await env.UPLOADS.delete(upload.raw_key);
  await logAuthEvent(env.DB, request, 'upload_discarded', { email: user.email });
  return donePage('Upload discarded', 'Nothing changed.');
}

// The collection must be as it was at preview: the guard uses that revision, and a collection that
// didn't exist then must not exist now.
async function applyPreview(env, user, upload, now) {
  const object = await env.UPLOADS.get(upload.raw_key);
  if (!object) throw new UploadProblem('The uploaded file is missing.');
  const planned = await planUpload(env.DB, user.id, upload, await object.text(), now);
  const { collection } = planned;
  if (upload.base_revision === null && !collection.isNew) {
    throw new UploadProblem(`${collection.name} was created since the preview.`);
  }
  if (upload.base_revision !== null) collection.revision = upload.base_revision || null;
  const note = `${upload.mode} from ${upload.file_name}`;
  if (!(await applyCollectionChanges(env.DB, user.id, [planned.change], { source: 'upload', note, now }))) {
    throw new UploadProblem(`${collection.name} changed since the preview.`);
  }
  return planned;
}

async function approve(request, env, { user, form, now, refuse }) {
  const upload = await claimUpload(env.DB, user, form, 'applying', now);
  if (!upload) return refuse('preview not pending', 'That preview has expired or was already used.');
  const finish = (status) => env.DB.prepare('UPDATE uploads SET status = ? WHERE id = ?').bind(status, upload.id).run();
  let planned;
  try {
    planned = await applyPreview(env, user, upload, now);
  } catch (error) {
    await finish('failed');
    if (!(error instanceof UploadProblem)) throw error;
    await logAuthEvent(env.DB, request, 'upload_failed', { email: user.email, detail: { mode: upload.mode } });
    return donePage('Nothing changed', `${error.message} Ask Claude for a new upload link and try again.`);
  }
  await finish('applied');
  await logAuthEvent(env.DB, request, 'upload_applied', {
    email: user.email,
    detail: { mode: upload.mode, format: upload.format, cards: planned.cards.length },
  });
  const verb = upload.mode === 'merge' ? 'Merged into' : 'Replaced';
  return donePage(
    'Upload applied',
    `${verb} ${planned.collection.name}: ${planned.cards.length} cards changed. Tell Claude it's done; collection_changes lists the changes.`,
  );
}

const STEPS = { preview, approve, discard };

// A form post: only from this page, with its body bounded before it's read.
async function posted(request, env, config, context) {
  if (request.headers.get('Origin') !== config.origin) return context.refuse('cross-origin post');
  const length = Number(request.headers.get('Content-Length'));
  if (!length) return errorPage(411, 'The upload needs a length.');
  if (length > MAX_UPLOAD_BYTES + FORM_OVERHEAD_BYTES) return errorPage(413, 'Files must be 5 MB or less.');
  const form = await request.formData();
  const step = String(form.get('step'));
  if (!Object.hasOwn(STEPS, step)) return errorPage(400, 'Unknown step.');
  return STEPS[step](request, env, { ...context, form });
}

export async function handleUpload(request, env, config) {
  const now = Date.now();
  const access = await verifyAccess(request, config);
  const refuse = async (reason, message = REFUSED) => {
    await logAuthEvent(env.DB, request, 'upload_refused', { email: access.email ?? null, detail: { reason } });
    return errorPage(403, message);
  };
  if (!access.email) return refuse(access.problem);
  if (!env.UPLOADS || !env.UPLOAD_SIGNING_KEY) return errorPage(503, 'Uploads are not set up on this server yet.');
  const user = await env.DB.prepare('SELECT id, email, disabled, pending FROM users WHERE email = ?')
    .bind(access.email)
    .first();
  if (!user || user.disabled || user.pending) return refuse('no active user for the Access identity');
  try {
    if (request.method === 'GET') {
      const token = new URL(request.url).searchParams.get('token');
      const link = await linkFor(env, user, token, now);
      if (link.problem) return refuse(link.problem);
      return formPage(user.email, token, { collection: link.claims.collection });
    }
    return await posted(request, env, config, { user, now, refuse });
  } catch (error) {
    if (!(error instanceof LinkKeyMissing)) throw error;
    return errorPage(503, 'Uploads are not set up on this server yet.');
  }
}
