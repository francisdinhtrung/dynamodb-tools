import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { COMMANDS, assertTableAllowed } from './commands.js';
import { UsageError, parseList, redact } from './util.js';

export const HELP = `ddb - read-only DynamoDB CLI for humans and AI agents. Output is JSON on stdout.

USAGE
  ddb list-tables [--limit N] [--next-token T]
  ddb describe <table>
  ddb get <table> --key '{"pk":"USER#1","sk":"PROFILE"}' [--projection a,b] [--consistent]
  ddb query <table> --pk <value> [sort-key condition] [--index NAME] [--desc]
                    [--limit N] [--next-token T] [--projection a,b] [--consistent]
  ddb scan <table> [--index NAME] [--limit N] [--next-token T] [--projection a,b]
  ddb sample <table> [-n N]      Scan N items (default 5) and infer attribute names/types

SORT-KEY CONDITIONS (query, pick at most one)
  --sk V | --sk-begins V | --sk-lt V | --sk-lte V | --sk-gt V | --sk-gte V | --sk-from A --sk-to B
  Key attribute names and types (S/N/B) are resolved automatically from the table/index schema.

GLOBAL OPTIONS
  --profile NAME        AWS profile (else AWS_PROFILE / default chain)
  --region REGION       AWS region (else AWS_REGION)
  --endpoint-url URL    e.g. http://localhost:8000 for DynamoDB Local (else DDB_ENDPOINT_URL)
  --redact a,b          Replace these attribute values with "[REDACTED]" (also DDB_REDACT env)
  --pretty              Indented JSON
  -h, --help

LIMITS & PAGINATION
  --limit defaults to 20 (max 100). When more data exists, output contains "nextToken";
  pass it back with --next-token to get the next page. null means no more data.

ENV
  DDB_ALLOWED_TABLES    Comma list of allowed tables; trailing * = prefix (e.g. "orders,app-dev-*")
  DDB_REDACT            Default --redact list

ERRORS
  Written to stderr as JSON {"error","message"}. Exit 2 = bad usage, 1 = AWS/runtime error.
`;

const OPTIONS = {
  profile: { type: 'string' },
  region: { type: 'string' },
  'endpoint-url': { type: 'string' },
  redact: { type: 'string' },
  pretty: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  limit: { type: 'string' },
  'next-token': { type: 'string' },
  key: { type: 'string' },
  projection: { type: 'string' },
  consistent: { type: 'boolean' },
  index: { type: 'string' },
  desc: { type: 'boolean' },
  pk: { type: 'string' },
  sk: { type: 'string' },
  'sk-begins': { type: 'string' },
  'sk-lt': { type: 'string' },
  'sk-lte': { type: 'string' },
  'sk-gt': { type: 'string' },
  'sk-gte': { type: 'string' },
  'sk-from': { type: 'string' },
  'sk-to': { type: 'string' },
  n: { type: 'string', short: 'n' },
};

export function makeClient(opts, env = process.env) {
  if (opts.profile) env.AWS_PROFILE = opts.profile;
  const endpoint = opts['endpoint-url'] || env.DDB_ENDPOINT_URL;
  const config = {
    region: opts.region || env.AWS_REGION || env.AWS_DEFAULT_REGION || (endpoint ? 'local' : undefined),
  };
  if (endpoint) {
    config.endpoint = endpoint;
    // DynamoDB Local accepts any credentials; avoid failing when none are configured.
    if (/localhost|127\.0\.0\.1/.test(endpoint) && !env.AWS_ACCESS_KEY_ID && !opts.profile && !env.AWS_PROFILE) {
      config.credentials = { accessKeyId: 'local', secretAccessKey: 'local' };
    }
  }
  return new DynamoDBClient(config);
}

export async function run(argv, { stdout = process.stdout, stderr = process.stderr, client } = {}) {
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    } catch (e) {
      throw new UsageError(e.message);
    }
    const { values: opts, positionals } = parsed;
    const [cmdName, table, ...extra] = positionals;

    if (opts.help || !cmdName || cmdName === 'help') {
      stdout.write(HELP);
      return 0;
    }
    const cmd = COMMANDS[cmdName];
    if (!cmd) throw new UsageError(`Unknown command "${cmdName}". Run "ddb --help".`);
    if (cmd.needsTable && !table) throw new UsageError(`"${cmdName}" requires a <table> argument`);
    if (extra.length || (!cmd.needsTable && table)) throw new UsageError(`Unexpected argument(s): ${[...(cmd.needsTable ? [] : [table]), ...extra].join(' ')}`);
    if (table) assertTableAllowed(table);

    opts.projection = parseList(opts.projection);
    const redactFields = new Set(parseList(opts.redact ?? process.env.DDB_REDACT));

    const result = await cmd.run(client ?? makeClient(opts), table, opts);
    stdout.write(JSON.stringify(redact(result, redactFields), null, opts.pretty ? 2 : 0) + '\n');
    return 0;
  } catch (e) {
    const usage = e instanceof UsageError;
    stderr.write(JSON.stringify({ error: e.name || 'Error', message: e.message }) + '\n');
    return usage ? 2 : 1;
  }
}
