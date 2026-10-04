import type { TestProject } from 'vitest/node';

import { prepareTestDatabase } from '../src/testing.js';
import type { TestDatabase } from '../src/testing.js';

declare module 'vitest' {
  export interface ProvidedContext {
    db: TestDatabase;
  }
}

export default async function setup(project: TestProject): Promise<void> {
  project.provide('db', await prepareTestDatabase('autoparts_test_db'));
}
