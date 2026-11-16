// Writes what OpenTofu made into wrangler.jsonc (the D1 and KV IDs, Access's team domain and audience
// tag), keeping its comments and layout. Run it after infra:apply with mise run infra:sync-wrangler,
// and commit the change.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { runTofu } from './tofu.mjs';

// Sets values in wrangler.jsonc, keeping its comments and layout.
export function editWranglerConfig(text, values) {
  const config = parse(text);
  let edited = text;
  const set = (path, value) => {
    edited = applyEdits(edited, modify(edited, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  };
  const kvIndex = config.kv_namespaces.findIndex((namespace) => namespace.binding === 'OAUTH_KV');
  const d1Index = config.d1_databases.findIndex((database) => database.binding === 'DB');
  if (values.kvId) set(['kv_namespaces', kvIndex, 'id'], values.kvId);
  if (values.d1Id) set(['d1_databases', d1Index, 'database_id'], values.d1Id);
  if (values.teamDomain) set(['vars', 'ACCESS_TEAM_DOMAIN'], values.teamDomain);
  if (values.accessAud) set(['vars', 'ACCESS_AUD'], values.accessAud);
  return edited;
}

// infra/outputs.tf's values, from `tofu output -json`.
export const valuesFromOutputs = (outputs) => ({
  d1Id: outputs.d1_database_id?.value,
  kvId: outputs.kv_namespace_id?.value,
  teamDomain: outputs.access_team_domain?.value,
  accessAud: outputs.access_aud?.value,
});

async function main() {
  const { status, stdout } = runTofu(['output', '-json'], { capture: true });
  if (status !== 0) throw new Error('tofu output failed; run mise run infra:apply first');
  const text = await readFile('wrangler.jsonc', 'utf8');
  const edited = editWranglerConfig(text, valuesFromOutputs(JSON.parse(stdout)));
  if (edited === text) return console.log('wrangler.jsonc already has these IDs.');
  await writeFile('wrangler.jsonc', edited);
  console.log('Updated wrangler.jsonc; commit it.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
