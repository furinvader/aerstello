import pg from 'pg';

import { ResourceRegistry, type ResourceRegistration } from './resource-registry.ts';

export interface OwnedDatabase {
  readonly client: pg.Client;
  dispose(): Promise<void>;
}

export async function connectDatabase(
  resources: ResourceRegistry,
  connectionString: string | undefined = process.env.DATABASE_URL,
): Promise<OwnedDatabase> {
  const client = new pg.Client(connectionString ? { connectionString } : undefined);
  let registration: ResourceRegistration<pg.Client>;
  try {
    registration = resources.own('PostgreSQL client', client, (ownedClient) => ownedClient.end());
  } catch (error) {
    await client.end();
    throw error;
  }

  try {
    await client.connect();
  } catch (error) {
    await registration.dispose();
    throw error;
  }

  return {
    client,
    dispose: () => registration.dispose(),
  };
}
