import {
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  GetItemCommand,
  ListTablesCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import {
  UsageError,
  assertTableAllowed,
  decodeToken,
  encodeToken,
  inferShape,
  isTableAllowed,
  keyValue,
  parseLimit,
  projection,
  toPlain,
} from './util.js';
import { marshall } from '@aws-sdk/util-dynamodb';

function keySchema(keyElements, attrDefs) {
  const typeOf = (name) => attrDefs.find((a) => a.AttributeName === name)?.AttributeType;
  const pk = keyElements.find((k) => k.KeyType === 'HASH');
  const sk = keyElements.find((k) => k.KeyType === 'RANGE');
  return {
    pk: pk && { name: pk.AttributeName, type: typeOf(pk.AttributeName) },
    sk: sk ? { name: sk.AttributeName, type: typeOf(sk.AttributeName) } : null,
  };
}

function summarizeIndex(idx, attrDefs) {
  return {
    name: idx.IndexName,
    ...keySchema(idx.KeySchema, attrDefs),
    projection: idx.Projection?.ProjectionType,
    ...(idx.Projection?.NonKeyAttributes && { nonKeyAttributes: idx.Projection.NonKeyAttributes }),
    ...(idx.IndexStatus && { status: idx.IndexStatus }),
  };
}

async function describeRaw(client, table) {
  const { Table } = await client.send(new DescribeTableCommand({ TableName: table }));
  return Table;
}

export async function listTables(client, opts) {
  const limit = parseLimit(opts.limit, { def: 100 });
  const res = await client.send(
    new ListTablesCommand({ Limit: limit, ExclusiveStartTableName: opts['next-token'] || undefined }),
  );
  return {
    tables: res.TableNames.filter((t) => isTableAllowed(t)),
    nextToken: res.LastEvaluatedTableName ?? null,
  };
}

export async function describe(client, table) {
  const t = await describeRaw(client, table);
  let ttl = null;
  try {
    const r = await client.send(new DescribeTimeToLiveCommand({ TableName: table }));
    const d = r.TimeToLiveDescription;
    if (d?.TimeToLiveStatus === 'ENABLED') ttl = d.AttributeName;
  } catch {
    // DescribeTimeToLive may be denied by IAM; TTL is optional info.
  }
  return {
    name: t.TableName,
    status: t.TableStatus,
    ...keySchema(t.KeySchema, t.AttributeDefinitions),
    billingMode: t.BillingModeSummary?.BillingMode ?? 'PROVISIONED',
    itemCountApprox: t.ItemCount,
    sizeBytesApprox: t.TableSizeBytes,
    gsi: (t.GlobalSecondaryIndexes ?? []).map((i) => summarizeIndex(i, t.AttributeDefinitions)),
    lsi: (t.LocalSecondaryIndexes ?? []).map((i) => summarizeIndex(i, t.AttributeDefinitions)),
    ttlAttribute: ttl,
    stream: t.StreamSpecification?.StreamEnabled ? t.StreamSpecification.StreamViewType : null,
    note: 'itemCountApprox/sizeBytesApprox are refreshed by AWS roughly every 6 hours',
  };
}

export async function get(client, table, opts) {
  if (!opts.key) throw new UsageError('get requires --key pk=VALUE[,sk=VALUE] or --key \'{"pk":"...","sk":"..."}\'');
  let key;
  if (opts.key.trim().startsWith('{')) {
    try {
      key = marshall(JSON.parse(opts.key));
    } catch {
      throw new UsageError('--key must be valid JSON');
    }
  } else {
    // name=value pairs; types come from the table schema. Shell-friendly (no JSON quoting in PowerShell/cmd).
    const t = await describeRaw(client, table);
    const typeOf = (name) => t.AttributeDefinitions.find((a) => a.AttributeName === name)?.AttributeType;
    key = {};
    for (const pair of opts.key.split(',')) {
      const eq = pair.indexOf('=');
      if (eq < 1) throw new UsageError(`Invalid --key part "${pair}", expected name=value`);
      const name = pair.slice(0, eq).trim();
      if (!t.KeySchema.some((k) => k.AttributeName === name)) {
        throw new UsageError(`"${name}" is not a key attribute of "${table}"`);
      }
      key[name] = keyValue(pair.slice(eq + 1), typeOf(name), name);
    }
  }
  const res = await client.send(
    new GetItemCommand({
      TableName: table,
      Key: key,
      ConsistentRead: !!opts.consistent,
      ...projection(opts.projection),
    }),
  );
  return { item: res.Item ? toPlain(res.Item) : null };
}

const SK_OPS = {
  'sk': '=',
  'sk-lt': '<',
  'sk-lte': '<=',
  'sk-gt': '>',
  'sk-gte': '>=',
};

export async function query(client, table, opts) {
  if (opts.pk === undefined) throw new UsageError('query requires --pk <value>');
  const t = await describeRaw(client, table);
  let schema;
  if (opts.index) {
    const idx = [...(t.GlobalSecondaryIndexes ?? []), ...(t.LocalSecondaryIndexes ?? [])].find(
      (i) => i.IndexName === opts.index,
    );
    if (!idx) throw new UsageError(`Index "${opts.index}" not found on table "${table}"`);
    schema = keySchema(idx.KeySchema, t.AttributeDefinitions);
  } else {
    schema = keySchema(t.KeySchema, t.AttributeDefinitions);
  }

  const names = { '#pk': schema.pk.name };
  const values = { ':pk': keyValue(opts.pk, schema.pk.type, schema.pk.name) };
  let cond = '#pk = :pk';

  const skConds = Object.keys(SK_OPS).filter((k) => opts[k] !== undefined);
  if (opts['sk-begins'] !== undefined) skConds.push('sk-begins');
  if (opts['sk-from'] !== undefined || opts['sk-to'] !== undefined) skConds.push('sk-between');
  if (skConds.length > 1) throw new UsageError(`Only one sort key condition allowed, got: ${skConds.join(', ')}`);
  if (skConds.length && !schema.sk) throw new UsageError('This table/index has no sort key');

  if (skConds.length) {
    const sk = schema.sk;
    names['#sk'] = sk.name;
    const op = skConds[0];
    if (op === 'sk-begins') {
      cond += ' AND begins_with(#sk, :sk)';
      values[':sk'] = keyValue(opts['sk-begins'], sk.type, sk.name);
    } else if (op === 'sk-between') {
      if (opts['sk-from'] === undefined || opts['sk-to'] === undefined) {
        throw new UsageError('--sk-from and --sk-to must be used together');
      }
      cond += ' AND #sk BETWEEN :sk AND :sk2';
      values[':sk'] = keyValue(opts['sk-from'], sk.type, sk.name);
      values[':sk2'] = keyValue(opts['sk-to'], sk.type, sk.name);
    } else {
      cond += ` AND #sk ${SK_OPS[op]} :sk`;
      values[':sk'] = keyValue(opts[op], sk.type, sk.name);
    }
  }

  const proj = projection(opts.projection);
  const res = await client.send(
    new QueryCommand({
      TableName: table,
      IndexName: opts.index,
      KeyConditionExpression: cond,
      ExpressionAttributeNames: { ...names, ...proj.ExpressionAttributeNames },
      ExpressionAttributeValues: values,
      ProjectionExpression: proj.ProjectionExpression,
      ScanIndexForward: !opts.desc,
      Limit: parseLimit(opts.limit),
      ExclusiveStartKey: decodeToken(opts['next-token']),
      ConsistentRead: opts.consistent && !opts.index ? true : undefined,
    }),
  );
  return {
    keyCondition: { [schema.pk.name]: opts.pk, ...(skConds.length && { sortKey: schema.sk.name }) },
    count: res.Count,
    items: res.Items.map(toPlain),
    nextToken: encodeToken(res.LastEvaluatedKey),
  };
}

export async function scan(client, table, opts) {
  const res = await client.send(
    new ScanCommand({
      TableName: table,
      IndexName: opts.index,
      Limit: parseLimit(opts.limit),
      ExclusiveStartKey: decodeToken(opts['next-token']),
      ...projection(opts.projection),
    }),
  );
  return {
    count: res.Count,
    items: res.Items.map(toPlain),
    nextToken: encodeToken(res.LastEvaluatedKey),
  };
}

export async function sample(client, table, opts) {
  const n = parseLimit(opts.n ?? opts.limit, { def: 5, max: 50 });
  const res = await client.send(new ScanCommand({ TableName: table, Limit: n }));
  return {
    sampled: res.Count,
    attributes: inferShape(res.Items),
    items: res.Items.map(toPlain),
    note: 'Attribute types use DynamoDB codes: S string, N number, B binary, BOOL, NULL, M map, L list, SS/NS/BS sets',
  };
}

export const COMMANDS = {
  'list-tables': { run: (c, _t, o) => listTables(c, o), needsTable: false },
  describe: { run: (c, t) => describe(c, t), needsTable: true },
  get: { run: get, needsTable: true },
  query: { run: query, needsTable: true },
  scan: { run: scan, needsTable: true },
  sample: { run: sample, needsTable: true },
};

export { assertTableAllowed };
