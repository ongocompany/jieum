/**
 * TipTap 루비문자(Ruby) 확장
 *
 * 한자 위에 읽기(병음, 훈독 등) 표시:
 *   <ruby>漢字<rt>한자</rt></ruby>
 */

import { Mark, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    ruby: {
      setRuby: (annotation: string) => ReturnType;
      unsetRuby: () => ReturnType;
    };
  }
}

export const Ruby = Mark.create({
  name: 'ruby',
  priority: 1000,

  addAttributes() {
    return {
      annotation: {
        default: null,
        parseHTML: (el) => {
          const rt = el.querySelector('rt');
          return rt?.textContent || null;
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'ruby' }];
  },

  renderHTML({ HTMLAttributes }) {
    const annotation = HTMLAttributes['annotation'] || '';
    return [
      'ruby',
      mergeAttributes(this.options?.HTMLAttributes ?? {}, {}),
      ['span', { class: 'ruby-base' }, 0],
      ['rt', {}, annotation],
    ];
  },

  addCommands() {
    return {
      setRuby:
        (annotation: string) =>
        ({ commands }) =>
          commands.setMark(this.name, { annotation }),
      unsetRuby:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});
