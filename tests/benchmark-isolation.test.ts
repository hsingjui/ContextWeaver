import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { initFilter } from '../src/scanner/filter.js';

test('benchmark information requests are not copied verbatim into indexable tests', async () => {
  const cases = JSON.parse(
    await readFile(path.resolve('benchmarks/retrieval/cases.json'), 'utf8'),
  ) as Array<{ id: string; informationRequest: string }>;
  const testFiles = (await readdir(path.resolve('tests'))).filter((file) => file.endsWith('.ts'));

  for (const file of testFiles) {
    const source = await readFile(path.resolve('tests', file), 'utf8');
    for (const benchmarkCase of cases) {
      assert.equal(
        source.includes(benchmarkCase.informationRequest),
        false,
        `${benchmarkCase.id} leaked verbatim into ${file}`,
      );
    }
  }
});

test('benchmark-only exclude patterns can remove tests without changing normal defaults', async () => {
  const normal = await initFilter(process.cwd());
  const benchmark = await initFilter(process.cwd(), ['tests/', 'test/', '__tests__/']);
  assert.equal(normal('src/search/SearchService.ts'), false);
  assert.equal(benchmark('src/search/SearchService.ts'), false);
  assert.equal(benchmark('tests/example.test.ts'), true);
});
