// Creates a demo single-table-design table in DynamoDB Local. Usage: npm run local:seed
import { CreateTableCommand, PutItemCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { pathToFileURL } from 'node:url';
import { makeClient } from '../src/cli.js';

export const TABLE = 'demo-app';

export const ITEMS = [
  { pk: 'USER#1', sk: 'PROFILE', type: 'user', name: 'An', email: 'an@example.com', gsi1pk: 'EMAIL#an@example.com', gsi1sk: 'USER#1' },
  { pk: 'USER#1', sk: 'ORDER#2026-01-05', type: 'order', total: 120.5, status: 'PAID', tags: new Set(['gift', 'vip']) },
  { pk: 'USER#1', sk: 'ORDER#2026-02-10', type: 'order', total: 42, status: 'SHIPPED' },
  { pk: 'USER#1', sk: 'ORDER#2026-03-15', type: 'order', total: 9.99, status: 'PENDING' },
  { pk: 'USER#2', sk: 'PROFILE', type: 'user', name: 'Binh', email: 'binh@example.com', gsi1pk: 'EMAIL#binh@example.com', gsi1sk: 'USER#2' },
];

export async function seed(client = makeClient({})) {
  try {
    await client.send(new DeleteTableCommand({ TableName: TABLE }));
  } catch {}
  await client.send(
    new CreateTableCommand({
      TableName: TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'gsi1pk', AttributeType: 'S' },
        { AttributeName: 'gsi1sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'gsi1pk', KeyType: 'HASH' },
            { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );
  for (const item of ITEMS) {
    await client.send(new PutItemCommand({ TableName: TABLE, Item: marshall(item) }));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await seed();
  console.log(`Seeded table "${TABLE}" with ${ITEMS.length} items`);
}
