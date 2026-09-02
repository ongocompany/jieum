import { describe, expect, it } from 'vitest';

import { stripMarkup } from '../build-golden.js';


describe('stripMarkup', () => {
  it('removes ordinary wiki and HTML markup', () => {
    expect(stripMarkup("'''굵게''' [[표시|문자]] <ref>주석</ref>")).toBe('굵게 문자 ');
  });

  it('does not let removed fragments form a new script tag', () => {
    const stripped = stripMarkup('앞<scr<span>무시</span>ipt>alert(1)</script>뒤');

    expect(stripped).not.toMatch(/[<>]/);
    expect(stripped.toLowerCase()).not.toContain('<script');
  });

  it('does not let removed fragments form a new comment opener', () => {
    const stripped = stripMarkup('앞<!<span>무시</span>--주석-->뒤');

    expect(stripped).not.toMatch(/[<>]/);
    expect(stripped).not.toContain('<!--');
  });
});
