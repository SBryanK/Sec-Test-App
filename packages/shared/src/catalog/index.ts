import type { TestCategory, TestCategoryId, TestDefinition, TestId } from '../types';
import { dosCategory, dosTests } from './dos';
import { webCategory, webTests } from './web';
import { botCategory, botTests } from './bot';
import { apiCategory, apiTests } from './api';

export const ALL_TESTS: TestDefinition[] = [
  ...dosTests,
  ...webTests,
  ...botTests,
  ...apiTests,
];

export const CATEGORIES: TestCategory[] = [dosCategory, webCategory, botCategory, apiCategory];

const TEST_INDEX = new Map<TestId, TestDefinition>(ALL_TESTS.map((t) => [t.id, t]));
const CATEGORY_INDEX = new Map<TestCategoryId, TestCategory>(CATEGORIES.map((c) => [c.id, c]));

export function getTest(id: TestId): TestDefinition {
  const test = TEST_INDEX.get(id);
  if (!test) throw new Error(`Unknown test id: ${id}`);
  return test;
}

export function tryGetTest(id: string): TestDefinition | undefined {
  return TEST_INDEX.get(id as TestId);
}

export function getCategory(id: TestCategoryId): TestCategory {
  const cat = CATEGORY_INDEX.get(id);
  if (!cat) throw new Error(`Unknown category id: ${id}`);
  return cat;
}

export function testsForCategory(id: TestCategoryId): TestDefinition[] {
  return getCategory(id).testIds.map(getTest);
}

export function isTestId(value: string): value is TestId {
  return TEST_INDEX.has(value as TestId);
}

export function isCategoryId(value: string): value is TestCategoryId {
  return CATEGORY_INDEX.has(value as TestCategoryId);
}

/** Every test id in catalog order — the order used by "Run All". */
export const ALL_TEST_IDS: TestId[] = ALL_TESTS.map((t) => t.id);

export const TEST_COUNT = ALL_TESTS.length;

export { dosCategory, dosTests, webCategory, webTests, botCategory, botTests, apiCategory, apiTests };
