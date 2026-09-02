import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkReleaseProjection,
  validateReleaseVersion,
  windowsFileVersion,
} from './release-version.mjs';

test('제품 버전과 빌드 번호를 검증한다', () => {
  assert.deepEqual(validateReleaseVersion({ version: '0.1.1', build: 2 }), {
    version: '0.1.1',
    build: 2,
  });
});

test('Windows 파일 버전의 네 번째 숫자에 빌드 번호를 넣는다', () => {
  assert.equal(windowsFileVersion({ version: '0.1.1', build: 2 }), '0.1.1.2');
});

for (const invalid of [
  { version: '0.1', build: 2 },
  { version: '00.1.1', build: 2 },
  { version: '0.1.1-beta', build: 2 },
  { version: '0.1.65536', build: 2 },
  { version: '0.1.1', build: 0 },
  { version: '0.1.1', build: 10_000 },
]) {
  test(`잘못된 정본을 거부한다: ${JSON.stringify(invalid)}`, () => {
    assert.throws(() => validateReleaseVersion(invalid));
  });
}

test('저장소의 플랫폼과 공개 문서가 정본 버전을 가리킨다', () => {
  assert.deepEqual(checkReleaseProjection(), { version: '0.1.1', build: 2 });
});
