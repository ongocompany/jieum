/**
 * 파일 저장/열기 — DOCX 기본, HTML/TXT 선택 가능
 * Tauri 네이티브 다이얼로그 + 웹 폴백
 */

import type { Editor } from '@tiptap/core';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  AlignmentType, UnderlineType,
} from 'docx';

export type FileFormat = 'docx' | 'rtf' | 'html' | 'txt';

interface TabState {
  filePath: string | null;
  format: FileFormat;
}

// Tauri API lazy init
let _tauriReady: Promise<boolean> | null = null;
let dialog: any = null;
let fs: any = null;

function getTauri(): Promise<boolean> {
  if (_tauriReady) return _tauriReady;
  _tauriReady = (async () => {
    try {
      // @ts-expect-error Tauri 환경 감지
      if (!window.__TAURI_INTERNALS__) return false;
      dialog = await import('@tauri-apps/plugin-dialog');
      fs = await import('@tauri-apps/plugin-fs');
      return true;
    } catch {
      return false;
    }
  })();
  return _tauriReady;
}

const SAVE_FILTERS = [
  { name: 'Word 문서 (.docx)', extensions: ['docx'] },
  { name: 'RTF 문서 (.rtf)', extensions: ['rtf'] },
  { name: 'HTML 문서 (.html)', extensions: ['html'] },
  { name: '텍스트 파일 (.txt)', extensions: ['txt'] },
];

const OPEN_FILTERS = [
  { name: '지원하는 문서', extensions: ['docx', 'rtf', 'html', 'htm', 'txt'] },
  { name: 'Word 문서 (.docx)', extensions: ['docx'] },
  { name: 'HTML 문서 (.html)', extensions: ['html', 'htm'] },
  { name: '텍스트 파일 (.txt)', extensions: ['txt'] },
  { name: '모든 파일', extensions: ['*'] },
];

// ─── 공개 API ───

export function newDocument(editor: Editor, setTitle: (t: string) => void, tab?: TabState): void {
  if (editor.getText().trim() && !confirm('현재 문서를 저장하지 않고 새 문서를 만들까요?')) return;
  editor.commands.clearContent();
  if (tab) { tab.filePath = null; tab.format = 'docx'; }
  setTitle('새 문서');
}

export async function openFile(editor: Editor, setTitle: (t: string) => void, tab?: TabState): Promise<void> {
  const isTauri = await getTauri();

  if (isTauri) {
    const path = await dialog.open({ filters: OPEN_FILTERS });
    if (!path) return;
    const pathStr = path as string;
    const ext = pathStr.split('.').pop()?.toLowerCase() ?? '';

    try {
      if (ext === 'txt') {
        const text = await fs.readTextFile(pathStr);
        editor.commands.setContent(text.split('\n').map((l: string) => `<p>${escapeHtml(l)}</p>`).join(''));
        if (tab) tab.format = 'txt';
      } else {
        const content = await fs.readTextFile(pathStr);
        loadHtml(editor, content);
        if (tab) tab.format = ext === 'docx' ? 'docx' : 'html';
      }
      if (tab) tab.filePath = pathStr;
      setTitle(extractFilename(pathStr));
    } catch (err) {
      console.error('[file-io] open error:', err);
      alert(`파일을 열 수 없습니다: ${err}`);
    }
  } else {
    // 웹 폴백
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.html,.htm,.txt';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      const text = await file.text();
      if (ext === 'txt') {
        editor.commands.setContent(text.split('\n').map(l => `<p>${escapeHtml(l)}</p>`).join(''));
        if (tab) tab.format = 'txt';
      } else {
        loadHtml(editor, text);
        if (tab) tab.format = 'html';
      }
      if (tab) tab.filePath = null;
      setTitle(file.name);
    };
    input.click();
  }
}

export async function saveFile(editor: Editor, setTitle: (t: string) => void, tab?: TabState): Promise<void> {
  const isTauri = await getTauri();
  if (tab?.filePath && isTauri) {
    try {
      await writeToFile(editor, tab.filePath, tab.format);
      setTitle(extractFilename(tab.filePath));
    } catch (err) {
      console.error('[file-io] save error:', err);
      alert(`저장 실패: ${err}`);
    }
    return;
  }
  return saveFileAs(editor, setTitle, tab);
}

export async function saveFileAs(editor: Editor, setTitle: (t: string) => void, tab?: TabState): Promise<void> {
  const isTauri = await getTauri();

  // 포맷 선택
  const format = await pickFormat(isTauri);
  if (!format) return;

  const extMap: Record<FileFormat, string> = { docx: '.docx', rtf: '.rtf', html: '.html', txt: '.txt' };
  const defaultName = '문서' + extMap[format];

  if (isTauri) {
    const path = await dialog.save({
      filters: [SAVE_FILTERS.find(f => f.extensions.includes(format))!],
      defaultPath: defaultName,
    });
    if (!path) return;

    try {
      await writeToFile(editor, path as string, format);
      if (tab) { tab.filePath = path as string; tab.format = format; }
      setTitle(extractFilename(path as string));
    } catch (err) {
      console.error('[file-io] saveAs error:', err);
      alert(`저장 실패: ${err}`);
    }
  } else {
    await downloadFile(editor, format);
  }
}

/** 포맷 선택 모달 */
function pickFormat(isTauri: boolean): Promise<FileFormat | null> {
  if (!isTauri) {
    const f = prompt('저장 포맷 (docx / html / txt):', 'docx');
    return Promise.resolve((f as FileFormat) || null);
  }

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.3);z-index:10000;display:flex;align-items:center;justify-content:center;';

    const modal = document.createElement('div');
    modal.style.cssText = 'background:white;border-radius:12px;padding:24px;box-shadow:0 8px 32px rgba(0,0,0,0.2);min-width:280px;font-family:inherit;';

    const title = document.createElement('h3');
    title.textContent = '저장 포맷 선택';
    title.style.cssText = 'margin:0 0 16px;font-size:16px;color:#1a1a1a;';
    modal.appendChild(title);

    const formats: { format: FileFormat; label: string; desc: string }[] = [
      { format: 'docx', label: 'Word 문서 (.docx)', desc: 'MS Word, 한글에서 열기 가능' },
      { format: 'rtf', label: 'RTF 문서 (.rtf)', desc: '서식 유지, 대부분의 에디터에서 열기 가능' },
      { format: 'html', label: 'HTML 문서 (.html)', desc: '웹 브라우저에서 열기 가능' },
      { format: 'txt', label: '텍스트 (.txt)', desc: '서식 없이 텍스트만 저장' },
    ];

    for (const f of formats) {
      const btn = document.createElement('button');
      btn.style.cssText = 'display:block;width:100%;text-align:left;padding:10px 14px;margin-bottom:6px;border:1px solid #ddd;border-radius:8px;background:white;cursor:pointer;font-size:14px;font-family:inherit;';
      btn.innerHTML = `<strong>${f.label}</strong><br><span style="font-size:11px;color:#888;">${f.desc}</span>`;
      btn.addEventListener('mouseenter', () => { btn.style.background = '#f0f4ff'; btn.style.borderColor = '#2563eb'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = 'white'; btn.style.borderColor = '#ddd'; });
      btn.addEventListener('click', () => { overlay.remove(); resolve(f.format); });
      modal.appendChild(btn);
    }

    const cancel = document.createElement('button');
    cancel.textContent = '취소';
    cancel.style.cssText = 'display:block;width:100%;padding:8px;margin-top:8px;border:none;background:none;cursor:pointer;color:#888;font-size:13px;font-family:inherit;';
    cancel.addEventListener('click', () => { overlay.remove(); resolve(null); });
    modal.appendChild(cancel);

    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
    document.body.appendChild(overlay);
  });
}

// ─── 내부 ───

async function writeToFile(editor: Editor, path: string, format: FileFormat): Promise<void> {
  if (format === 'docx') {
    const blob = await buildDocx(editor);
    const buffer = new Uint8Array(await blob.arrayBuffer());
    await fs.writeFile(path, buffer);
  } else if (format === 'rtf') {
    await fs.writeTextFile(path, buildRtf(editor));
  } else if (format === 'txt') {
    await fs.writeTextFile(path, editor.getText());
  } else {
    await fs.writeTextFile(path, buildHtml(editor));
  }
}

async function downloadFile(editor: Editor, format: FileFormat): Promise<void> {
  let blob: Blob;
  let filename: string;

  if (format === 'docx') {
    blob = await buildDocx(editor);
    filename = '문서.docx';
  } else if (format === 'rtf') {
    blob = new Blob([buildRtf(editor)], { type: 'application/rtf' });
    filename = '문서.rtf';
  } else if (format === 'txt') {
    blob = new Blob([editor.getText()], { type: 'text/plain;charset=utf-8' });
    filename = '문서.txt';
  } else {
    blob = new Blob([buildHtml(editor)], { type: 'text/html;charset=utf-8' });
    filename = '문서.html';
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── DOCX 변환 ───

async function buildDocx(editor: Editor): Promise<Blob> {
  const json = editor.getJSON();
  const children: Paragraph[] = [];

  function processContent(content: any[]): Paragraph[] {
    const paragraphs: Paragraph[] = [];
    for (const node of content) {
      if (node.type === 'paragraph') {
        paragraphs.push(new Paragraph({
          children: buildTextRuns(node.content || []),
          alignment: getAlignment(node.attrs?.textAlign),
        }));
      } else if (node.type === 'heading') {
        const level = node.attrs?.level ?? 1;
        const headingMap: Record<number, typeof HeadingLevel[keyof typeof HeadingLevel]> = {
          1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3,
        };
        paragraphs.push(new Paragraph({
          children: buildTextRuns(node.content || []),
          heading: headingMap[level] ?? HeadingLevel.HEADING_1,
        }));
      } else if (node.type === 'bulletList' || node.type === 'orderedList') {
        for (const item of (node.content || [])) {
          if (item.type === 'listItem') {
            for (const child of (item.content || [])) {
              paragraphs.push(new Paragraph({
                children: buildTextRuns(child.content || []),
                bullet: node.type === 'bulletList' ? { level: 0 } : undefined,
                numbering: node.type === 'orderedList' ? { reference: 'default-numbering', level: 0 } : undefined,
              }));
            }
          }
        }
      } else if (node.type === 'blockquote') {
        for (const child of (node.content || [])) {
          paragraphs.push(new Paragraph({
            children: buildTextRuns(child.content || []),
            indent: { left: 720 },
          }));
        }
      }
    }
    return paragraphs;
  }

  function buildTextRuns(content: any[]): TextRun[] {
    const runs: TextRun[] = [];
    for (const node of content) {
      if (node.type === 'text') {
        const marks = node.marks || [];
        const opts: any = { text: node.text || '' };
        for (const mark of marks) {
          if (mark.type === 'bold') opts.bold = true;
          if (mark.type === 'italic') opts.italics = true;
          if (mark.type === 'underline') opts.underline = { type: UnderlineType.SINGLE };
          if (mark.type === 'strike') opts.strike = true;
          if (mark.type === 'superscript') opts.superScript = true;
          if (mark.type === 'subscript') opts.subScript = true;
          if (mark.type === 'textStyle') {
            if (mark.attrs?.fontSize) {
              const pt = parseInt(mark.attrs.fontSize);
              if (pt) opts.size = pt * 2;
            }
            if (mark.attrs?.fontFamily) {
              opts.font = { name: mark.attrs.fontFamily.split(',')[0].replace(/['"]/g, '').trim() };
            }
            if (mark.attrs?.color) {
              opts.color = mark.attrs.color.replace('#', '');
            }
          }
        }
        runs.push(new TextRun(opts));
      }
    }
    if (runs.length === 0) runs.push(new TextRun({ text: '' }));
    return runs;
  }

  function getAlignment(align: string | undefined) {
    if (align === 'center') return AlignmentType.CENTER;
    if (align === 'right') return AlignmentType.RIGHT;
    if (align === 'justify') return AlignmentType.JUSTIFIED;
    return undefined;
  }

  if (json.content) children.push(...processContent(json.content));

  const doc = new Document({
    sections: [{ children: children.length > 0 ? children : [new Paragraph({ children: [new TextRun('')] })] }],
  });

  return Packer.toBlob(doc);
}

// ─── RTF 변환 ───

function buildRtf(editor: Editor): string {
  const json = editor.getJSON();
  let rtf = '{\\rtf1\\ansi\\deff0\n';
  rtf += '{\\fonttbl{\\f0 Noto Sans KR;}{\\f1 Arial;}}\n';
  rtf += '{\\colortbl;\\red0\\green0\\blue0;\\red102\\green102\\blue102;}\n';
  rtf += '\\f0\\fs32\n'; // 기본 폰트 16pt (RTF는 half-point)

  if (json.content) {
    for (const node of json.content) {
      rtf += convertNodeToRtf(node);
    }
  }

  rtf += '}';
  return rtf;
}

function convertNodeToRtf(node: any): string {
  if (node.type === 'paragraph') {
    return '\\pard ' + convertInlineContent(node.content || []) + '\\par\n';
  }
  if (node.type === 'heading') {
    const level = node.attrs?.level ?? 1;
    const sizes: Record<number, number> = { 1: 56, 2: 44, 3: 36 }; // half-points
    return `\\pard\\b\\fs${sizes[level] ?? 56} ` + convertInlineContent(node.content || []) + '\\b0\\fs32\\par\n';
  }
  if (node.type === 'bulletList') {
    let rtf = '';
    for (const item of (node.content || [])) {
      if (item.type === 'listItem') {
        for (const child of (item.content || [])) {
          rtf += '\\pard\\li720\\bullet  ' + convertInlineContent(child.content || []) + '\\par\n';
        }
      }
    }
    return rtf;
  }
  if (node.type === 'orderedList') {
    let rtf = '';
    let num = 1;
    for (const item of (node.content || [])) {
      if (item.type === 'listItem') {
        for (const child of (item.content || [])) {
          rtf += `\\pard\\li720 ${num}. ` + convertInlineContent(child.content || []) + '\\par\n';
          num++;
        }
      }
    }
    return rtf;
  }
  if (node.type === 'blockquote') {
    let rtf = '';
    for (const child of (node.content || [])) {
      rtf += '\\pard\\li720\\cf2 ' + convertInlineContent(child.content || []) + '\\cf1\\par\n';
    }
    return rtf;
  }
  if (node.type === 'horizontalRule') {
    return '\\pard\\brdrb\\brdrs\\brdrw10\\brsp20\\par\n';
  }
  return '';
}

function convertInlineContent(content: any[]): string {
  let rtf = '';
  for (const node of content) {
    if (node.type === 'text') {
      const marks = node.marks || [];
      let pre = '';
      let post = '';
      for (const mark of marks) {
        if (mark.type === 'bold') { pre += '\\b '; post = '\\b0 ' + post; }
        if (mark.type === 'italic') { pre += '\\i '; post = '\\i0 ' + post; }
        if (mark.type === 'underline') { pre += '\\ul '; post = '\\ulnone ' + post; }
        if (mark.type === 'strike') { pre += '\\strike '; post = '\\strike0 ' + post; }
        if (mark.type === 'superscript') { pre += '\\super '; post = '\\nosupersub ' + post; }
        if (mark.type === 'subscript') { pre += '\\sub '; post = '\\nosupersub ' + post; }
      }
      // RTF에서 유니코드 문자 인코딩
      const text = escapeRtf(node.text || '');
      rtf += pre + text + post;
    }
  }
  return rtf;
}

function escapeRtf(text: string): string {
  let result = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 127) {
      // 유니코드 → \\uN?
      result += `\\u${code}?`;
    } else if (ch === '\\' || ch === '{' || ch === '}') {
      result += '\\' + ch;
    } else {
      result += ch;
    }
  }
  return result;
}

// ─── HTML ───

function buildHtml(editor: Editor): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>지음편집기 문서</title>
<style>
body { font-family: "Noto Sans KR", "Pretendard", sans-serif; line-height: 1.8; padding: 40px 60px; max-width: 800px; margin: 0 auto; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #ccc; padding: 8px 12px; }
th { background: #f5f5f5; }
ruby rt { font-size: 0.55em; color: #888; }
blockquote { border-left: 3px solid #ddd; padding-left: 16px; color: #666; }
</style>
</head>
<body>
${editor.getHTML()}
</body>
</html>`;
}

function loadHtml(editor: Editor, html: string): void {
  const match = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  editor.commands.setContent(match ? match[1]! : html);
}

function extractFilename(path: string): string {
  return path.split('/').pop()?.split('\\').pop() || '문서';
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
