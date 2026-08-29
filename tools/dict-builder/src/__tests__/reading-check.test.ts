import { describe, it, expect } from 'vitest';
import { classify, loadReadings, splitVariant, type ReadingTable } from '../reading-check.js';

/**
 * 실제 독음표(data/source/hanja-readings.json, 8,976자)의 부분집합 —
 * 아래 시험 사례에 필요한 글자만 남겼다. 값은 그 파일에서 그대로 가져왔다.
 */
function fixtureReadings(): ReadingTable {
  return loadReadings({
    竝: ['병'],
    記: ['기'],
    倂: ['병'],
    鹵: ['로'],
    簿: ['부'],
    半: ['반'],
    仗: ['장'],
    瀨: ['뢰'],
    戶: ['호'],
    內: ['내'],
    海: ['해'],
    快: ['쾌'],
    適: ['적'],
    無: ['무'],
    關: ['관'],
    新: ['신'],
    年: ['년', '연'],
    音: ['음'],
    樂: ['낙', '락', '악', '요'],
    會: ['회'],
    金: ['금', '김'],
    曜: ['요'],
    日: ['일'],
    浦: ['포'],
    掛: ['괘'],
    鐘: ['종'],
    鷄: ['계'],
    鳴: ['명'],
    丑: ['축'],
    時: ['시'],
    權: ['권'],
    鼎: ['정'],
    立: ['립', '입'],
    兵: ['병'],
    假: ['가'],
    郎: ['랑'],
    廳: ['청'],
    兼: ['겸'],
    強: ['강'],
    直: ['직'],
    性: ['성'],
    攣: ['련'],
    縮: ['축'],
    愛: ['애'],
    鄰: ['린'],
    如: ['여'],
    己: ['기'],
  });
}

describe('reading-check', () => {
  const readings = fixtureReadings();

  it('병기 / 竝記倂記 → repeat, [竝記, 倂記]', () => {
    expect(classify('병기', '竝記倂記', readings)).toBe('repeat');
    expect(splitVariant('병기', '竝記倂記', readings)).toEqual(['竝記', '倂記']);
  });

  it('노부반장 / 鹵簿半仗 → ok (두음법칙: 로→노)', () => {
    expect(classify('노부반장', '鹵簿半仗', readings)).toBe('ok');
  });

  it('뇌호내해 / 瀨戶內海 → ok (두음법칙: 뢰→뇌)', () => {
    expect(classify('뇌호내해', '瀨戶內海', readings)).toBe('ok');
  });

  it('쾌적하다 / 快適 → ok (용언 어미 "하다" 제거)', () => {
    expect(classify('쾌적하다', '快適', readings)).toBe('ok');
  });

  it('무관히 / 無關 → ok (용언 어미 "히" 제거)', () => {
    expect(classify('무관히', '無關', readings)).toBe('ok');
  });

  it('신년 음악회 / 新年音樂會 → ok (공백 제거)', () => {
    expect(classify('신년 음악회', '新年音樂會', readings)).toBe('ok');
  });

  it('금요일 / 金曜日, 김포 / 金浦 → ok (金의 다음향: 금/김)', () => {
    expect(classify('금요일', '金曜日', readings)).toBe('ok');
    expect(classify('김포', '金浦', readings)).toBe('ok');
  });

  it('괘종시계 / 掛鐘 → truncated (한자가 표제어보다 짧음)', () => {
    expect(classify('괘종시계', '掛鐘', readings)).toBe('truncated');
  });

  it('계명 / 鷄鳴丑時 → extended (한자가 표제어보다 김)', () => {
    expect(classify('계명', '鷄鳴丑時', readings)).toBe('extended');
  });

  it('권외 / 權內 → partial (앞 글자만 일치: 權=권, 內≠외)', () => {
    // 발주서 표는 이 사례를 'unrelated'로 적었지만, audit2.py를 그대로 이
    // (word, hanja) 쌍에 돌리면 'partial'이 나온다 — 권(權)까지는 읽히고
    // 외(內)에서 갈린다(prefix_len=1>0, 길이도 같아 truncated/extended 조건에
    // 걸리지 않는다). 두 실행(전체 사전 스캔 오라클, 함수 직접 호출) 모두
    // 동일해 포팅 쪽 문제가 아니라 발주서 표의 오기로 판단했다. build.ts는
    // partial/unrelated를 동일하게 제거하므로 최종 산출물(사전에서 후보가
    // 빠지는 결과)에는 영향이 없다.
    expect(classify('권외', '權內', readings)).toBe('partial');
  });

  it('정치 / 鼎立 → partial (앞 글자만 일치: 鼎=정, 立≠치)', () => {
    // 위와 같은 사유 — 발주서 표는 'unrelated'로 적었지만 실제로는 'partial'.
    expect(classify('정치', '鼎立', readings)).toBe('partial');
  });

  it('가낭청 / 假郎廳 → ok (합성어 내부 경계 두음법칙: 郎廳=낭청, 郎 본음 랑)', () => {
    // 처음엔 두음법칙을 어두(index 0)에서만 봤다 — 假=가는 그대로 맞지만
    // 郎(본음 랑)이 word[1]='낭'으로 읽히는 건 어두가 아니라서 놓쳤고
    // 'partial'로 잘못 잘렸다. 郎廳이 그 자체로 독립된 단어라 내부 경계에서
    // 두음법칙이 다시 적용된다 — 그 경계를 미리 알 수 없으므로 모든 위치에서
    // 변형을 인정하도록 canRead를 고쳤다.
    expect(classify('가낭청', '假郎廳', readings)).toBe('ok');
  });

  it('겸낭청 / 兼郎廳 → ok (위와 같은 구조)', () => {
    expect(classify('겸낭청', '兼郎廳', readings)).toBe('ok');
  });

  it('강직성연축 / 強直性攣縮 → ok (攣 본음 련 → 연)', () => {
    expect(classify('강직성연축', '強直性攣縮', readings)).toBe('ok');
  });

  it('애인여기 / 愛鄰如己 → ok (鄰 본음 린 → 인)', () => {
    expect(classify('애인여기', '愛鄰如己', readings)).toBe('ok');
  });

  it('독음표에 없는 글자가 하나라도 있으면 unknown (읽히는 글자가 있어도)', () => {
    // 兵=병은 표에 있지만 言은 없다 — 앞이 맞아도 unknown이 이긴다.
    expect(classify('병언', '兵言', readings)).toBe('unknown');
  });

  it('repeat이 아니면 splitVariant는 null을 반환한다', () => {
    expect(splitVariant('노부반장', '鹵簿半仗', readings)).toBeNull();
    expect(splitVariant('괘종시계', '掛鐘', readings)).toBeNull();
    expect(splitVariant('병언', '兵言', readings)).toBeNull();
  });

  it('loadReadings는 JSON 배열을 조회용 Set으로 바꾼다', () => {
    const table = loadReadings({ 金: ['금', '김'] });
    expect(table.get('金')).toEqual(new Set(['금', '김']));
    expect(table.get('無')).toBeUndefined();
  });
});
