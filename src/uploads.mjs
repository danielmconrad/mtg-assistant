// /upload: the upload page, from a signed link import_collection or import_binder made. It imports a file
// into one binder, or a ManaBox export as the whole collection. Cloudflare Access guards the route, and the
// Access identity must be the link's user. Choosing a file previews it: the raw file goes to the private
// R2 bucket and a row in uploads, and the page lists what would change. Nothing is applied until the person
// confirms that preview, which works once and carries its own CSRF token. Applying replans from the stored
// file, guarded on every touched binder's revision at preview, so it applies exactly what the preview
// showed or nothing.
import { parse } from 'csv-parse/sync';
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
import {
  BINDER_NAME_RULE,
  applyCollectionChanges,
  entriesFor,
  isValidBinderName,
  newBinder,
  planAdd,
  planReplace,
  replaceEvents,
  sourceRecords,
} from './storage/collection-writes.mjs';
import { listCollections } from './storage/collections.mjs';
import { loadAllDecks } from './storage/decks.mjs';

export const UPLOAD_PURPOSE = 'upload';
export const UPLOAD_TTL_MS = 10 * 60 * 1000;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
// Each preview uses the link once, so a wrong file or setting can be fixed; each preview applies once.
export const MAX_UPLOAD_PREVIEWS = 3;
export const UPLOAD_MODES = ['merge', 'replace'];
export const UPLOAD_TARGETS = ['binder', 'collection'];
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
    records = parse(text, { bom: true, skip_empty_lines: true, columns: true });
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
  const kept = sourceRecords(text);
  return rows.map((row) => ({
    ...row,
    sourceRecord: kept[row.position],
    binder: records[row.position]['Binder Name']?.trim() ?? '',
    binderType: records[row.position]['Binder Type']?.trim().toLowerCase() ?? '',
  }));
}

// One binder's change: rows merged in or replacing its own. The binder's format follows a replacing file.
async function binderChange(db, userId, collection, rows, { merge, format }) {
  const entries = collection.isNew ? [] : await entriesFor(db, userId, collection.id);
  const plan = merge ? planAdd(entries, rows) : planReplace(entries, rows);
  const events = merge
    ? rows.map((row) => ({ name: row.name, scryfallId: row.scryfallId, finish: row.finish, change: row.quantity }))
    : replaceEvents(entries, rows);
  const changedFormat = !merge && !collection.isNew && collection.format !== format ? format : undefined;
  return {
    change: { collection, plan, events, format: changedFormat },
    before: entries,
    after: merge ? [...entries, ...rows] : rows,
  };
}

// The page's view of a set of binder changes: each binder's net card changes and the decks naming them.
function summarized(planned, decks, extra = {}) {
  const before = new Map(
    planned.filter((item) => !item.change.collection.isNew).map((item) => [item.change.collection.name, item.before]),
  );
  const after = new Map(
    planned.filter((item) => !item.change.remove).map((item) => [item.change.collection.name, item.after]),
  );
  const changes = collectionChanges(before, after);
  return {
    changes: planned.map((item) => item.change),
    binders: changes,
    cards: changes.reduce((sum, binder) => sum + binder.cards.length, 0),
    decks: decksNaming(
      changes,
      decks.filter(({ deck }) => isActiveDeck(deck)),
    ),
    ...extra,
  };
}

// What a binder upload does: one binder, merged or replaced, created if new.
async function planBinder(db, userId, upload, text, now) {
  const rows = await uploadedRows(db, text, { format: upload.format, fileName: upload.file_name });
  let target;
  try {
    target = await targetCollection(db, userId, upload.collection_name, { create: true, now, format: upload.format });
  } catch (error) {
    throw asProblem(error);
  }
  const item = await binderChange(db, userId, target.collection, rows, {
    merge: upload.mode === 'merge',
    format: upload.format,
  });
  return summarized([item], target.decks, { skipped: [] });
}

// A ManaBox export's binders, in the file's order: each Binder Name with its rows, ManaBox decks as deck
// binders. Lists (wishlists) aren't owned cards, so they're left out and counted.
function fileBinders(rows) {
  const binders = new Map();
  let listCopies = 0;
  for (const row of rows) {
    if (row.binderType === 'list') {
      listCopies += row.quantity;
      continue;
    }
    const name = row.binder || 'ManaBox';
    if (!isValidBinderName(name)) {
      throw new UploadProblem(`The binder "${name}" can't be a binder name: ${BINDER_NAME_RULE}.`);
    }
    const binder = binders.get(name) ?? { name, kind: 'binder', rows: [] };
    if (row.binderType === 'deck') binder.kind = 'deck';
    binder.rows.push(row);
    binders.set(name, binder);
  }
  return { binders: [...binders.values()], listCopies };
}

// What a whole-collection upload does. Merging adds each ManaBox binder's cards to the binder of that name,
// creating the ones that are new: ManaBox decks as protected deck binders, the rest unprotected. Replacing
// also makes each binder exactly the file's and removes binders the file doesn't have, so the collection
// becomes the file. A built deck's binder is never changed by an upload; it's listed as skipped.
async function planWholeCollection(db, userId, upload, text, now) {
  if (upload.format !== 'manabox_csv') {
    throw new UploadProblem('A whole collection comes from a ManaBox CSV export, which names each card’s binder.');
  }
  const { binders, listCopies } = fileBinders(
    await uploadedRows(db, text, { format: upload.format, fileName: upload.file_name }),
  );
  const [existing, decks] = await Promise.all([listCollections(db, userId), loadAllDecks(db, userId)]);
  const builtInto = (binder) => decks.find(({ deck }) => deck.collection_destination === binder.path);
  const merge = upload.mode === 'merge';
  const planned = [];
  const skipped = [];
  for (const binder of binders) {
    const current = existing.find((candidate) => candidate.name === binder.name);
    const built = current && builtInto(current);
    if (built) {
      skipped.push(`${binder.name} holds the built deck ${built.slug}; it changes only with that deck`);
      continue;
    }
    const collection = current ?? newBinder(binder.name, now, { format: upload.format, kind: binder.kind });
    planned.push(await binderChange(db, userId, collection, binder.rows, { merge, format: upload.format }));
  }
  if (!merge) {
    const named = new Set(binders.map((binder) => binder.name));
    for (const collection of existing.filter((candidate) => !named.has(candidate.name) && !builtInto(candidate))) {
      const item = await binderChange(db, userId, collection, [], { merge: false, format: collection.format });
      planned.push({ ...item, change: { ...item.change, remove: true } });
    }
  }
  if (listCopies) skipped.push(`${listCopies} copies in ManaBox lists, which are wishlists rather than owned cards`);
  return summarized(planned, decks, { skipped });
}

const planUpload = (db, userId, upload, text, now) =>
  (upload.target === 'collection' ? planWholeCollection : planBinder)(db, userId, upload, text, now);

// Each touched binder's revision at preview, as uploads.base_revisions keeps it: null for a new binder.
const revisionsOf = (changes) =>
  Object.fromEntries(
    changes.map(({ collection }) => [collection.name, collection.isNew ? null : (collection.revision ?? '')]),
  );

// ---------------------------------------------------------------------------------------------
// Pages. Everything from the request, the file or the person's data is escaped.

const lines = (text) => escapeHtml(text).replace(/\n/g, '<br>');
const count = (number, noun) => `${number} ${noun}${number === 1 ? '' : 's'}`;

function formPage(email, token, { target = 'binder', collection = '', mode = 'merge', problem } = {}) {
  const radio = (name, value, current, label, detail) =>
    `<label class="choice"><input type="radio" name="${name}" value="${value}"${current === value ? ' checked' : ''}><span><b>${label}</b><small>${detail}</small></span></label>`;
  return htmlPage(
    'Import cards',
    `<h1>Import cards</h1>
<p>Signed in as <strong>${escapeHtml(email)}</strong>.</p>
${problem ? `<p class="warn">${lines(problem)}</p>` : ''}
<form method="post" action="/upload" enctype="multipart/form-data">
  <input type="hidden" name="step" value="preview">
  <input type="hidden" name="token" value="${escapeHtml(token)}">
  <p><label>A ManaBox CSV export (.csv) or a text list (.txt), 5 MB at most<br>
    <input type="file" name="file" accept=".csv,.txt" required></label></p>
  <fieldset><legend>Import into</legend>
  ${radio('target', 'collection', target, 'The whole collection, from a ManaBox CSV export', 'One binder per ManaBox binder, with ManaBox decks as protected deck binders.')}
  ${radio('target', 'binder', target, 'One binder', 'Named below. A new name starts a new binder.')}
  <label>Binder name
    <input name="collection" value="${escapeHtml(collection)}" maxlength="120"></label></fieldset>
  <fieldset><legend>How</legend>
  ${radio('mode', 'merge', mode, 'Merge', 'Add the file’s cards to what’s there.')}
  ${radio('mode', 'replace', mode, 'Replace', 'The binder, or the whole collection, becomes exactly the file.')}</fieldset>
  <p><button>Preview</button></p>
</form>`,
    { status: problem ? 400 : 200 },
  );
}

const STATUS_LABELS = { added: 'new', removed: 'removed', changed: 'changed' };

function binderSection({ collection, status, cards }, changes) {
  const signed = ({ name, change }) => `${change > 0 ? '+' : ''}${change} ${name}`;
  const target = changes.find((change) => change.collection.name === collection)?.collection;
  const labels = [
    STATUS_LABELS[status],
    target?.kind === 'deck' && 'deck',
    target?.protected && 'protected: never used by other decks',
  ].filter(Boolean);
  const shown = cards.slice(0, CHANGES_SHOWN).map((card) => `<li>${escapeHtml(signed(card))}</li>`);
  const more = cards.length > CHANGES_SHOWN ? `<li>and ${cards.length - CHANGES_SHOWN} more</li>` : '';
  return `<h2>${escapeHtml(collection)} (${escapeHtml(labels.join(', '))})</h2><ul>${shown.join('')}${more}</ul>`;
}

function previewPage(upload, { changes, binders, cards, decks, skipped }) {
  const verb = upload.mode === 'merge' ? 'Merge' : 'Replace';
  const what = upload.target === 'collection' ? 'your whole collection' : upload.collection_name;
  return htmlPage(
    'Import preview',
    `<h1>${verb} ${escapeHtml(what)}?</h1>
<p>From ${escapeHtml(upload.file_name)}. ${cards ? `${count(cards, 'card change')} in ${count(binders.length, 'binder')}:` : 'Nothing would change.'}</p>
${binders.map((binder) => binderSection(binder, changes)).join('\n')}
${decks.length ? `<p>Decks naming changed cards: ${escapeHtml(decks.map(({ deck, cards: named }) => `${deck} (${named.join(', ')})`).join('; '))}</p>` : ''}
${skipped.length ? `<p class="warn">Left out: ${escapeHtml(skipped.join('; '))}.</p>` : ''}
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

// The form's target, binder name and mode, defaulting to merging into a binder.
function choices(form) {
  const target = UPLOAD_TARGETS.includes(form.get('target')) ? form.get('target') : 'binder';
  return {
    target,
    collection: target === 'binder' ? String(form.get('collection') ?? '').trim() : '',
    mode: UPLOAD_MODES.includes(form.get('mode')) ? form.get('mode') : 'merge',
  };
}

async function preview(request, env, { user, form, now, refuse }) {
  const token = String(form.get('token') ?? '');
  const link = await linkFor(env, user, token, now);
  if (link.problem) return refuse(link.problem);
  if (!(await useLink(env.DB, link.claims, MAX_UPLOAD_PREVIEWS, now))) return refuse('used up');
  const { target, collection, mode } = choices(form);
  const file = form.get('file');
  const upload = { id: crypto.randomUUID(), target, collection_name: collection, mode, csrf: randomToken() };
  let text;
  let planned;
  try {
    if (target === 'binder' && (!collection || collection.length > 120)) throw new UploadProblem('Name the binder.');
    ({ text, format: upload.format } = await fileText(file));
    upload.file_name = file.name.slice(-120);
    planned = await planUpload(env.DB, user.id, upload, text, now);
  } catch (error) {
    if (error instanceof UploadProblem) {
      return formPage(user.email, token, { target, collection, mode, problem: error.message });
    }
    throw error;
  }
  const rawKey = `uploads/${user.id}/${upload.id}`;
  await env.UPLOADS.put(rawKey, text, {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    customMetadata: { target, collection, mode, format: upload.format },
  });
  await env.DB.prepare(
    `INSERT INTO uploads (id, user_id, target, collection_name, mode, format, file_name, size, raw_key, csrf,
       base_revisions, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      upload.id,
      user.id,
      target,
      collection,
      mode,
      upload.format,
      upload.file_name,
      file.size,
      rawKey,
      upload.csrf,
      JSON.stringify(revisionsOf(planned.changes)),
      new Date(now).toISOString(),
      now + PREVIEW_TTL_MS,
    )
    .run();
  await logAuthEvent(env.DB, request, 'upload_previewed', {
    email: user.email,
    detail: {
      target,
      mode,
      format: upload.format,
      size: file.size,
      new: planned.changes.filter((change) => change.collection.isNew).length,
    },
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

// Every binder must be as it was at preview: the same binders touched, each guarded on its revision then,
// and none that was new then may exist now.
async function applyPreview(env, user, upload, now) {
  const object = await env.UPLOADS.get(upload.raw_key);
  if (!object) throw new UploadProblem('The uploaded file is missing.');
  const planned = await planUpload(env.DB, user.id, upload, await object.text(), now);
  const previewed = JSON.parse(upload.base_revisions ?? '{}');
  const changedSince = new UploadProblem('Your binders changed since the preview.');
  if (Object.keys(previewed).length !== planned.changes.length) throw changedSince;
  for (const { collection } of planned.changes) {
    if (!Object.hasOwn(previewed, collection.name)) throw changedSince;
    const revision = previewed[collection.name];
    if ((revision === null) !== Boolean(collection.isNew)) throw changedSince;
    if (revision !== null) collection.revision = revision || null;
  }
  const note = `${upload.mode} from ${upload.file_name}`;
  if (!(await applyCollectionChanges(env.DB, user.id, planned.changes, { source: 'upload', note, now }))) {
    throw changedSince;
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
    await logAuthEvent(env.DB, request, 'upload_failed', {
      email: user.email,
      detail: { target: upload.target, mode: upload.mode },
    });
    return donePage('Nothing changed', `${error.message} Ask Claude for a new upload link and try again.`);
  }
  await finish('applied');
  await logAuthEvent(env.DB, request, 'upload_applied', {
    email: user.email,
    detail: { target: upload.target, mode: upload.mode, format: upload.format, cards: planned.cards },
  });
  const verb = upload.mode === 'merge' ? 'Merged into' : 'Replaced';
  const what = upload.target === 'collection' ? 'your collection' : upload.collection_name;
  return donePage(
    'Import applied',
    `${verb} ${what}: ${count(planned.cards, 'card change')} in ${count(planned.binders.length, 'binder')}. Tell Claude it's done; collection_changes lists the changes.`,
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

// The upload pages post their own forms, and posted() refuses a post whose Origin isn't this server. Under
// the site-wide no-referrer policy browsers send Origin: null on those posts, so these pages use
// same-origin: the real Origin on their own posts, and still no referrer to any other site.
export async function handleUpload(request, env, config) {
  const response = await uploadResponse(request, env, config);
  response.headers.set('Referrer-Policy', 'same-origin');
  return response;
}

async function uploadResponse(request, env, config) {
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
      return formPage(user.email, token, {
        target: link.claims.target,
        collection: link.claims.collection,
        mode: link.claims.mode,
      });
    }
    return await posted(request, env, config, { user, now, refuse });
  } catch (error) {
    if (!(error instanceof LinkKeyMissing)) throw error;
    return errorPage(503, 'Uploads are not set up on this server yet.');
  }
}
