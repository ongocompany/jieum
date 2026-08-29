import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SERVER_VERSION } from '../version.js';

describe('SERVER_VERSION', () => {
  /**
   * version.ts는 package.json을 import하지 않는다 (tsc rootDir 함정을 피하려고).
   * 그 대가로 두 값이 어긋날 수 있으므로, 어긋남을 시험이 막는다.
   * hello 응답의 serverVersion이 거짓말을 하면 원격 진단이 불가능해진다.
   */
  it('package.json의 version과 일치한다', () => {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    expect(SERVER_VERSION).toBe(pkg.version);
  });
});
