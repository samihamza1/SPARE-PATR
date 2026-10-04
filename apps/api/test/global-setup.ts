import type { TestProject } from 'vitest/node';

import { prepareTestDatabase } from '@autoparts/db/testing';
import type { TestDatabase } from '@autoparts/db/testing';

declare module 'vitest' {
  export interface ProvidedContext {
    db: TestDatabase;
  }
}

export default async function setup(project: TestProject): Promise<void> {
  project.provide('db', await prepareTestDatabase('autoparts_test_api'));
}
