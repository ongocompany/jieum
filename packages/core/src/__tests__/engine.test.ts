import { describe, it, expect } from 'vitest';
import { JieumEngine } from '../engine.js';
import { DECAY_TICKS, MruStore } from '../mru.js';
import { UserWordStore } from '../user-words.js';
import type { DictSnapshot, ImeEntry } from '../types.js';

function e(h: string, f = 0, l = 0): ImeEntry {
  return { h, f, l };
}

function createTestSnapshot(): DictSnapshot {
  const dict = new Map([
    ['경제', [e('經濟', 90)]],
    ['발전', [e('發展', 120), e('發電', 80)]],
    ['발전소', [e('發電所', 0)]],
    ['원자력', [e('原子力', 0)]],
    ['대한', [e('大韓', 100), e('大恨', 10)]],
    ['민국', [e('民國', 0)]],
    ['학교', [e('學校', 95)]],
    ['교육', [e('敎育', 85)]],
  ]);

  const compound = new Map([
    ['원자력', '原子力'],
    ['발전소', '發電所'],
  ]);

  const blocklist = new Set(['나라', '사람', '하늘']);

  return { dict, compound, blocklist };
}

describe('JieumEngine', () => {
  describe('convert', () => {
    it('기본 변환을 수행한다', () => {
      const engine = new JieumEngine(createTestSnapshot());
      const results = engine.convert('경제');

      expect(results).toHaveLength(1);
      expect(results[0]!.word).toBe('경제');
      expect(results[0]!.hanja).toBe('經濟');
    });

    it('공백으로 구분된 여러 단어를 변환한다', () => {
      const engine = new JieumEngine(createTestSnapshot());
      const results = engine.convert('경제 발전');

      expect(results).toHaveLength(2);
      expect(results[0]!.word).toBe('경제');
      expect(results[1]!.word).toBe('발전');
    });

    it('복합어에 보너스를 부여한다', () => {
      const engine = new JieumEngine(createTestSnapshot());
      const results = engine.convert('발전소');

      expect(results).toHaveLength(1);
      expect(results[0]!.hanja).toBe('發電所');
      expect(results[0]!.candidates[0]!.source).toBe('compound');
    });

    it('동음이의어를 빈도순으로 정렬한다', () => {
      const engine = new JieumEngine(createTestSnapshot());
      const results = engine.convert('발전');

      const candidates = results[0]!.candidates;
      expect(candidates[0]!.hanja).toBe('發展'); // freq 120
      expect(candidates[1]!.hanja).toBe('發電'); // freq 80
    });

    it('블록리스트 단어는 변환하지 않는다', () => {
      const engine = new JieumEngine(createTestSnapshot());
      const results = engine.convert('나라');
      expect(results).toHaveLength(0);
    });

    it('startIdx와 endIdx가 정확하다', () => {
      const engine = new JieumEngine(createTestSnapshot());
      const results = engine.convert('경제 발전');

      expect(results[0]!.startIdx).toBe(0);
      expect(results[0]!.endIdx).toBe(2);
      expect(results[1]!.startIdx).toBe(3);
      expect(results[1]!.endIdx).toBe(5);
    });
  });

  describe('convertToString', () => {
    it('한자 annotation이 포함된 문자열을 반환한다', () => {
      const engine = new JieumEngine(createTestSnapshot());
      const result = engine.convertToString('경제 발전');
      expect(result).toBe('경제(經濟) 발전(發展)');
    });

    it('조사는 그대로 유지한다', () => {
      const engine = new JieumEngine(createTestSnapshot());
      const result = engine.convertToString('경제의 발전을');
      // "의"와 "을"은 사전에 없으므로 그대로 통과
      expect(result).toContain('경제(經濟)');
      expect(result).toContain('발전(發展)');
    });

    it('사전에 없는 단어는 원문 그대로 유지한다', () => {
      const engine = new JieumEngine(createTestSnapshot());
      const result = engine.convertToString('좋은 경제');
      expect(result).toBe('좋은 경제(經濟)');
    });

    it('빈 문자열을 처리한다', () => {
      const engine = new JieumEngine(createTestSnapshot());
      expect(engine.convertToString('')).toBe('');
    });
  });

  describe('segment', () => {
    it('텍스트를 세그먼트로 분할한다', () => {
      const engine = new JieumEngine(createTestSnapshot());
      const segs = engine.segment('경제 발전');

      expect(segs).toHaveLength(3);
      expect(segs[0]).toEqual({ text: '경제', type: 'hanja_candidate', convertible: true });
      expect(segs[1]).toEqual({ text: ' ', type: 'whitespace', convertible: false });
      expect(segs[2]).toEqual({ text: '발전', type: 'hanja_candidate', convertible: true });
    });

    it('조사를 particle로 분류한다', () => {
      const engine = new JieumEngine(createTestSnapshot());
      const segs = engine.segment('학교의');

      const particleSeg = segs.find((s) => s.type === 'particle');
      expect(particleSeg?.text).toBe('의');
    });
  });

  /**
   * 입력기가 매 키 입력마다 버퍼 구간을 좁힐 때 쓰는 가벼운 조회.
   * lookup()과 판정 기준(블록리스트)이 어긋나면 후보가 있다고 보고
   * 좁힌 구간에서 정작 아무것도 못 찾는 상태가 된다.
   */
  describe('hasWord', () => {
    it('사전에 그대로 있는 표제어만 참이다', () => {
      const engine = new JieumEngine(createTestSnapshot());

      expect(engine.hasWord('경제')).toBe(true);
      expect(engine.hasWord('발전소')).toBe(true);
      expect(engine.hasWord('담철')).toBe(false);
      expect(engine.hasWord('')).toBe(false);
    });

    it('접두사만 일치하는 경우는 거짓이다', () => {
      const engine = new JieumEngine(createTestSnapshot());

      // '발전'은 있지만 '발전이'라는 표제어는 없다
      expect(engine.hasWord('발전이')).toBe(false);
    });

    it('블록리스트 단어는 사전에 있어도 거짓이다 (lookup과 동일 기준)', () => {
      const snapshot = createTestSnapshot();
      snapshot.blocklist.add('경제');
      const engine = new JieumEngine(snapshot);

      expect(engine.hasWord('경제')).toBe(false);
      expect(engine.lookup('경제')).toHaveLength(0);
    });
  });
});

/**
 * 조사·어미 경계 스냅샷
 *
 * createTestSnapshot()과 달리 조사·어미를 한자 표제어로 등재해 실제 사전
 * 조건을 재현한다. 실제 사전에는 의(意)·을(乙)·다(多)·가(家)가 존재하므로
 * 최장일치가 항상 성공하고, PARTICLES/VERB_SUFFIXES는 도달하지 못한다.
 * 1음절 한자도 함께 등재해 "어근이 사전에 있는지"로는 어근+어미와 2음절
 * 한자어를 구분할 수 없는 상황을 만든다.
 */
function createGrammarSnapshot(): DictSnapshot {
  const dict = new Map([
    // 뒷글자가 조사·어미와 형태가 같은 2음절 한자어
    ['한자', [e('漢字', 100)]],
    ['문서', [e('文書', 90)]],
    ['국가', [e('國家', 95)]],
    ['학자', [e('學者', 80)]],
    ['중요', [e('重要', 110)]],
    ['장군', [e('將軍', 70)]],
    ['정지', [e('停止', 60)]],
    ['발전', [e('發展', 120)]],
    ['경제', [e('經濟', 90)]],
    ['경제가', [e('經濟家', 0)]],
    ['학교', [e('學校', 95)]],
    ['명령', [e('命令', 90)]],
    ['전문', [e('專門', 70)]],
    ['전문가', [e('專門家', 80)]],
    // 실제 사전에는 활용형과 희귀 전문어도 완전한 표제어로 존재한다.
    ['발전하다', [e('發展', 0)]],
    ['위한', [e('胃寒', 0)]],
    // 1음절 한자 — 어근으로 오인되는 원인
    ['한', [e('韓', 50)]],
    ['문', [e('門', 40)]],
    ['국', [e('國', 45)]],
    ['학', [e('學', 55)]],
    ['중', [e('中', 65)]],
    ['장', [e('長', 35)]],
    ['정', [e('正', 30)]],
    ['위', [e('偉', 20)]],
    ['내', [e('內', 20)]],
    ['보', [e('報', 20)]],
    ['하', [e('下', 20)]],
    ['행', [e('行', 20)]],
    ['행하', [e('行下', 0)]],
    // 고유어 어절의 꼬리를 이루는 1음절 한자 — 실제 사전에 모두 있다.
    // 이것들이 존재하기 때문에 "꼬리가 사전에 없으면 고유어"라는 판별이
    // 성립하지 않는다.
    ['산', [e('山', 60)]],
    ['린', [e('隣', 5)]],
    ['올', [e('兀', 3)]],
    ['라', [e('羅', 8)]],
    ['간', [e('間', 40)]],
    // 조사·어미의 한자 표제어
    ['의', [e('意', 10)]],
    ['을', [e('乙', 5)]],
    ['다', [e('多', 8)]],
    ['가', [e('家', 12)]],
    ['에', [e('恚', 3)]],
  ]);

  return { dict, compound: new Map(), blocklist: new Set() };
}

describe('조사·어미 경계', () => {
  /**
   * 회귀 가드 — 반드시 통과 상태를 유지한다.
   *
   * 2026-08-01 조사 수정 시도에서 "어근이 사전에 있으면 어미를 벗긴다"는
   * 규칙 때문에 한자→한(韓)자, 국가→국(國)가로 깨진 전례가 있다.
   * 1음절 한자는 사실상 모두 사전에 있으므로 그 조건은 가드가 되지 못한다.
   */
  describe('2음절 한자어 보존', () => {
    it('뒷글자가 조사·어미와 같아도 쪼개지 않는다', () => {
      const engine = new JieumEngine(createGrammarSnapshot());
      const words = engine.convert('한자 문서 국가 학자').map((r) => r.word);

      expect(words).toEqual(['한자', '문서', '국가', '학자']);
    });

    it('한자어를 원래 한자로 변환한다', () => {
      const engine = new JieumEngine(createGrammarSnapshot());

      expect(engine.convertToString('한자 문서')).toBe('한자(漢字) 문서(文書)');
      expect(engine.convertToString('중요 장군 정지')).toBe(
        '중요(重要) 장군(將軍) 정지(停止)',
      );
    });
  });

  /**
   * 목표 동작 — 아직 미구현.
   *
   * 조사·어미가 한자 표제어로 존재해 최장일치에 먹히는 문제
   * (boundary.ts:segment는 사전 매칭을 먼저 시도하므로
   * isParticleOrSuffix에 도달하지 못한다).
   * 구현 시 skip을 풀고 위 회귀 가드와 함께 통과시켜야 한다.
   */
  describe('조사·어미 비변환', () => {
    it('문절 끝 조사를 한자로 바꾸지 않는다', () => {
      const engine = new JieumEngine(createGrammarSnapshot());

      expect(engine.convertToString('경제 발전을')).toBe('경제(經濟) 발전(發展)을');
      expect(engine.convertToString('학교에')).toBe('학교(學校)에');
    });

    it('종결어미를 한자로 바꾸지 않는다', () => {
      const engine = new JieumEngine(createGrammarSnapshot());

      expect(engine.convertToString('발전한다')).toBe('발전(發展)한다');
      expect(engine.convertToString('발전하다')).toBe('발전(發展)하다');
    });

    it('완전한 사전 표제어가 있어도 문장 문맥의 조사를 분리한다', () => {
      const engine = new JieumEngine(createGrammarSnapshot());

      expect(engine.convertToString('경제가 발전하다')).toBe(
        '경제(經濟)가 발전(發展)하다',
      );
    });

    it('목적격 조사 뒤 위한과 고유어 용언을 변환하지 않는다', () => {
      const engine = new JieumEngine(createGrammarSnapshot());

      expect(engine.convertToString('발전을 위한 학자')).toBe(
        '발전(發展)을 위한 학자(學者)',
      );
      expect(engine.convertToString('내렸다')).toBe('내렸다');
      expect(engine.convertToString('내다 가다 보다 하다')).toBe('내다 가다 보다 하다');
      expect(engine.convertToString('행하다')).toBe('행(行)하다');
    });

    /**
     * 회귀 가드 — 이 가드는 한 번 죽은 적이 있다.
     *
     * 원래 판별은 "1음절 매칭 뒤 꼬리가 사전에 없으면 고유어"였는데,
     * 1음절 한자 5,978자가 사실상 모든 음절을 덮어 조건이 영원히 거짓이었다
     * (린=隣, 라=羅, 간=間). 통과되지 않는 가드라 테스트도 조용히 초록이었다.
     * 그래서 이 시험은 꼬리 글자를 **일부러 사전에 등재한 채로** 세운다.
     */
    it('1음절 뒤 조사가 아닌 꼬리가 붙으면 어절 전체를 고유어로 둔다', () => {
      const engine = new JieumEngine(createGrammarSnapshot());

      // 린·라·간이 모두 사전에 있는데도 쪼개지 않아야 한다
      expect(engine.convertToString('내린다')).toBe('내린다');
      expect(engine.convertToString('올라간다')).toBe('올라간다');
    });

    it('꼬리가 조사면 1음절 어근을 계속 변환한다', () => {
      const engine = new JieumEngine(createGrammarSnapshot());

      // 위 가드가 과하게 작동해 정당한 1음절 변환까지 막으면 안 된다
      expect(engine.convertToString('산에')).toBe('산(山)에');
    });

    it('문맥 없는 완전한 한자 표제어는 보존한다', () => {
      const engine = new JieumEngine(createGrammarSnapshot());

      expect(engine.convertToString('전문가')).toBe('전문가(專門家)');
      expect(engine.convertToString('위한')).toBe('위한(胃寒)');
    });

    it('문장부호가 붙어도 조사·어미와 앞뒤 문맥을 판별한다', () => {
      const engine = new JieumEngine(createGrammarSnapshot());

      expect(engine.convertToString('발전하다.')).toBe('발전(發展)하다.');
      expect(engine.convertToString('경제가, 발전하다.')).toBe(
        '경제(經濟)가, 발전(發展)하다.',
      );
      expect(engine.convertToString('발전을, 위한 학자')).toBe(
        '발전(發展)을, 위한 학자(學者)',
      );
    });

    it('문절 시작의 단독 조사 형태는 변환 후보로 남긴다', () => {
      const engine = new JieumEngine(createGrammarSnapshot());
      const segs = engine.segment('가 문서');

      expect(segs[0]).toEqual({ text: '가', type: 'hanja_candidate', convertible: true });
    });
  });
});

/**
 * 2층(고어·전문어) 스냅샷
 *
 * 실제 사전의 구성비를 재현한다: 표제어의 74%가 2층 후보밖에 없고,
 * 11%만 1층과 2층이 섞여 있다.
 */
function createTierSnapshot(): DictSnapshot {
  function a(h: string, f = 0): ImeEntry {
    return { h, f, l: 0, a: true };
  }

  const dict = new Map([
    // 1층과 2층이 섞인 표제어 — 첫 줄은 1층만
    ['정치', [e('政治', 90), a('定置'), a('情致'), a('鼎峙')]],
    // 2층 후보밖에 없는 전공 어휘 — 첫 줄로 승격돼야 한다
    ['거담작용', [a('祛痰作用')]],
    ['갱죽', [a('羹粥')]],
    // 1층만
    ['경제', [e('經濟', 90)]],
    // 길이가 다른 매칭이 함께 잡히는 경우.
    // 짧은 쪽이 살아남으려면 남는 꼬리가 조사여야 한다 — `정도`의 `도`가 그렇다
    // (`isHeadwordTail`). `정치`로는 `정`이 걸러지므로 순서를 볼 수 없다.
    ['정', [e('正', 50), a('鼎'), a('穽')]],
    ['정도', [e('程度', 80), a('正道')]],
  ]);

  return { dict, compound: new Map(), blocklist: new Set() };
}

describe('2층(고어·전문어) 분리', () => {
  it('1층 후보가 있으면 2층을 별도 그룹으로 내린다', () => {
    const engine = new JieumEngine(createTierSnapshot());
    const groups = engine.lookup('정치').filter((g) => g.word === '정치');

    expect(groups.map((g) => g.type)).toEqual(['normal', 'archaic']);
    expect(groups[0]!.candidates.map((c) => c.hanja)).toEqual(['政治']);
    expect(groups[1]!.candidates.map((c) => c.hanja)).toEqual(['定置', '情致', '鼎峙']);
  });

  it('1층 후보가 없으면 2층을 첫 줄로 승격한다', () => {
    // 지음 사전 표제어의 74%가 이 경우다. 펼쳐야만 보이면
    // 2층 후보만 있는 표제어가 첫 화면에서 사라지면 안 된다.
    const engine = new JieumEngine(createTierSnapshot());

    for (const word of ['거담작용', '갱죽']) {
      const groups = engine.lookup(word).filter((g) => g.word === word);
      expect(groups).toHaveLength(1);
      expect(groups[0]!.type).toBe('normal');
    }
  });

  it('긴 매칭을 먼저, 그 안에서 층 순서로 낸다', () => {
    // 층을 전역 우선순위로 올리면 "정도"의 2층이 "정"의 1층 뒤로 밀려,
    // 사용자가 친 단어의 후보를 한참 지나야 만나게 된다
    const engine = new JieumEngine(createTierSnapshot());
    const groups = engine.lookup('정도');

    expect(groups.map((g) => `${g.word}:${g.type}`)).toEqual([
      '정도:normal',
      '정도:archaic',
      '정:normal',
      '정:archaic',
    ]);
  });

  it('2층 후보는 목록에서 빠지지 않고 뒤로만 밀린다', () => {
    const engine = new JieumEngine(createTierSnapshot());
    const all = engine.lookup('정치')
      .filter((g) => g.word === '정치')
      .flatMap((g) => g.candidates.map((c) => c.hanja));

    expect(all).toEqual(['政治', '定置', '情致', '鼎峙']);
  });

  it('2층 표시를 후보에 실어 보낸다', () => {
    const engine = new JieumEngine(createTierSnapshot());
    const groups = engine.lookup('정치').filter((g) => g.word === '정치');

    expect(groups[0]!.candidates[0]!.archaic).toBeFalsy();
    expect(groups[1]!.candidates.every((c) => c.archaic)).toBe(true);
  });
});

describe('바이너리 사전 왕복', () => {
  it('2층 표시가 write → read를 건너 살아남는다', async () => {
    // 플래그를 비트필드로 바꿨으므로 bit0(인명용)과 bit1(2층)이
    // 서로를 덮어쓰지 않는지 확인한다
    const { buildBinary, loadBinary } = await import('../binary-dict.js');

    const buffer = buildBinary({
      dict: {
        정치: [
          { h: '政治', f: 90, l: 3 },
          { h: '定置', f: 0, l: 0, a: true },
        ],
        민: [
          { h: '閔', f: 0, l: 0, n: true },
          { h: '旻', f: 0, l: 0, n: true, a: true },
        ],
      },
      compound: {},
      blocklist: [],
    });

    const snapshot = loadBinary(buffer);

    const jeongchi = snapshot.lookup!.exactMatch('정치')!;
    expect(jeongchi[0]!.a).toBeUndefined();
    expect(jeongchi[1]!.a).toBe(true);

    const min = snapshot.lookup!.exactMatch('민')!;
    expect(min[0]!.n).toBe(true);
    expect(min[0]!.a).toBeUndefined();
    expect(min[1]!.n).toBe(true);
    expect(min[1]!.a).toBe(true);
  });

  it('u8을 넘는 빈도를 순위가 뒤집히지 않게 자른다', async () => {
    // setUint8은 범위를 넘으면 256으로 나눈 나머지를 쓴다. 그대로 두면
    // 1891 → 99가 되어 90짜리 후보에게 1위를 내준다. 실제로 v1 빈도의
    // `이상/以上`(1891)·`의미/意味`(1078)가 이렇게 손상돼 있었다.
    const { buildBinary, loadBinary } = await import('../binary-dict.js');

    const buffer = buildBinary({
      dict: {
        이상: [
          { h: '以上', f: 1891, l: 0 },
          { h: '異常', f: 90, l: 0 },
        ],
      },
      compound: {},
      blocklist: [],
    });

    const entries = loadBinary(buffer).lookup!.exactMatch('이상')!;

    expect(entries[0]!.f).toBe(255);
    expect(entries[0]!.f).toBeGreaterThan(entries[1]!.f);
  });
});

describe('최근 변환 이력 (MRU)', () => {
  function tierEngineWithMru() {
    const mru = new MruStore();
    const engine = new JieumEngine(createTierSnapshot(), { mru });
    return { engine, mru };
  }

  it('한 번 고른 후보가 다음 조회에서 위로 온다', () => {
    const { engine } = tierEngineWithMru();

    // 처음에는 사전 순 — 政治가 1번
    expect(engine.lookup('정치')[0]!.candidates[0]!.hanja).toBe('政治');

    engine.recordChoice('정치', '定置', 1000);

    // 定置는 2층인데도 1층 위로 올라와야 한다.
    // 한 번 선택한 2층 후보는 다음 조회에서 앞에 온다
    const groups = engine.lookup('정치').filter((g) => g.word === '정치');
    expect(groups[0]!.candidates[0]!.hanja).toBe('定置');
  });

  it('2층 감점을 넘어야 의미가 있다 — 보너스가 감점보다 크다', () => {
    const { engine } = tierEngineWithMru();
    engine.recordChoice('정치', '鼎峙', 1000);

    const top = engine.lookup('정치')[0]!.candidates[0]!;
    expect(top.hanja).toBe('鼎峙');
    expect(top.archaic).toBe(true);
  });

  it('여러 번 고른 것이 한 번 고른 것보다 위로 온다', () => {
    const { engine } = tierEngineWithMru();

    engine.recordChoice('정치', '情致', 1000);
    for (let i = 0; i < 3; i++) engine.recordChoice('정치', '定置', 2000 + i);

    const hanja = engine.lookup('정치')[0]!.candidates.map((c) => c.hanja);
    expect(hanja.indexOf('定置')).toBeLessThan(hanja.indexOf('情致'));
  });

  it('표제어가 다르면 이력이 번지지 않는다', () => {
    // "정치"에서 政治를 골랐다고 "정"에서 政이 올라오면 안 된다
    const { engine } = tierEngineWithMru();
    engine.recordChoice('정치', '政治', 1000);

    const jeong = engine.lookup('정').filter((g) => g.word === '정');
    expect(jeong[0]!.candidates[0]!.hanja).toBe('正');
  });

  it('고른 횟수를 후보에 실어 보낸다', () => {
    const { engine } = tierEngineWithMru();
    engine.recordChoice('정치', '定置', 1000);
    engine.recordChoice('정치', '定置', 2000);

    const top = engine.lookup('정치')[0]!.candidates[0]!;
    expect(top.used).toBe(2);
  });

  it('이력이 없으면 사전 순서 그대로다', () => {
    const engine = new JieumEngine(createTierSnapshot());
    expect(engine.lookup('정치')[0]!.candidates[0]!.hanja).toBe('政治');
  });
});

describe('이력의 감쇠 (Rime formula_d 방식)', () => {
  /** 다른 글자를 계속 확정해 tick만 밀어 올린다 */
  function typeOtherWords(mru: MruStore, times: number) {
    for (let i = 0; i < times; i++) {
      mru.record(`딴말${i}`, `他${i}`, 10_000 + i);
    }
  }

  it('안 쓰는 사이 다른 글자를 치면 사용량이 흐려진다', () => {
    const mru = new MruStore();
    mru.record('정치', '定置', 1000);
    const fresh = mru.get('정치', '定置')!.strength;

    typeOtherWords(mru, DECAY_TICKS);

    const faded = mru.get('정치', '定置')!.strength;
    // 시상수만큼 지났으면 1/e(약 0.368)로 준다
    expect(faded).toBeLessThan(fresh);
    expect(faded / fresh).toBeCloseTo(Math.exp(-1), 2);
  });

  it('날짜가 아니라 친 양이 기준이다 — 가만히 두면 흐려지지 않는다', () => {
    const mru = new MruStore();
    mru.record('정치', '定置', 1000);
    const fresh = mru.get('정치', '定置')!.strength;

    // 한 달이 지났지만 그동안 아무것도 확정하지 않았다.
    // 오래 쉬었다고 이력이 날아가면 안 된다.
    const later = mru.get('정치', '定置')!.strength;
    expect(later).toBe(fresh);
  });

  it('오래 안 쓴 이력은 결국 잊힌다', () => {
    const mru = new MruStore();
    mru.record('정치', '定置', 1000);

    typeOtherWords(mru, 1000);

    expect(mru.get('정치', '定置')).toBeUndefined();
  });

  it('잊히면 고어 감점이 제자리로 돌아온다', () => {
    // 이것이 감쇠를 넣은 이유다. 이력이 있으면 랭커가 2층 감점을 면제하는데,
    // 1년 전에 한 번 고른 고어가 그 면제를 영원히 들고 있으면 오늘 처음 보는
    // 현대어보다 계속 위에 온다.
    const mru = new MruStore();
    const engine = new JieumEngine(createTierSnapshot(), { mru });

    engine.recordChoice('정치', '鼎峙', 1000);
    expect(engine.lookup('정치')[0]!.candidates[0]!.hanja).toBe('鼎峙');

    typeOtherWords(mru, 1000);

    expect(engine.lookup('정치')[0]!.candidates[0]!.hanja).toBe('政治');
  });

  it('최근에 세 번 쓴 것이 예전에 열 번 쓴 것을 이긴다', () => {
    // 단순히 횟수를 경과로 나누는 것으로는 안 되는 구분이다.
    // 확정 시점에 옛 값을 흐린 뒤 더하기 때문에 성립한다.
    const mru = new MruStore();
    for (let i = 0; i < 10; i++) mru.record('정치', '情致', 1000 + i);

    typeOtherWords(mru, 400);

    for (let i = 0; i < 3; i++) mru.record('정치', '定置', 50_000 + i);

    const old = mru.get('정치', '情致')!.strength;
    const recent = mru.get('정치', '定置')!.strength;
    expect(recent).toBeGreaterThan(old);
  });

  it('옛 형식 이력은 버리지 않고 이어받는다', () => {
    // 감쇠를 도입했다는 이유로 그동안 쌓인 이력을 날리면 안 된다.
    const restored = MruStore.fromJSON({
      '정치\t定置': [7, 1000],
      '경제\t經濟': [1, 2000],
    });

    expect(restored.size).toBe(2);
    // 그동안의 횟수가 사용량의 출발값이 된다
    expect(restored.get('정치', '定置')!.strength).toBeCloseTo(7, 6);
    expect(restored.get('경제', '經濟')!.strength).toBeCloseTo(1, 6);
  });
});

describe('MruStore', () => {
  it('직렬화하고 복원한다', () => {
    const store = new MruStore();
    store.record('정치', '定置', 1000);
    store.record('정치', '定置', 2000);
    store.record('경제', '經濟', 3000);

    const restored = MruStore.fromJSON(store.toJSON());

    expect(restored.get('정치', '定置')).toMatchObject({ count: 2, at: 2000 });
    expect(restored.get('경제', '經濟')).toMatchObject({ count: 1, at: 3000 });
    expect(restored.size).toBe(2);

    // 감쇠 상태(사용량·tick)까지 살아남아야 한다. 안 그러면 복원할 때마다
    // 모든 이력이 "방금 쓴 것"으로 되살아나 감쇠가 무의미해진다.
    const before = store.get('정치', '定置')!.strength;
    expect(restored.get('정치', '定置')!.strength).toBeCloseTo(before, 6);
  });

  it('망가진 스냅샷은 조용히 걸러낸다', () => {
    const restored = MruStore.fromJSON({
      '정치\t定置': [2, 1000],
      '형식이\t틀림': ['x', 'y'],
      '구분자없음': [1, 1],
      깨짐: null,
    });

    expect(restored.size).toBe(1);
    expect(restored.get('정치', '定置')?.count).toBe(2);
  });

  it('용량을 넘으면 오래 안 쓴 것부터 버린다', () => {
    // 횟수가 아니라 시각 기준 — 지금 쓰는 글의 어휘가 더 가깝다
    const store = new MruStore(2);
    store.record('가', '可', 1000);
    store.record('나', '奈', 2000);
    store.record('다', '多', 3000);

    expect(store.size).toBe(2);
    expect(store.get('가', '可')).toBeUndefined();
    expect(store.get('다', '多')).toBeDefined();
  });

  it('빈 값은 기록하지 않는다', () => {
    const store = new MruStore();
    store.record('', '定置', 1000);
    store.record('정치', '', 1000);
    expect(store.size).toBe(0);
  });
});

describe('MRU 최근성', () => {
  /**
   * 방금 고른 후보가 2번에 머물던 회귀를 재현한다.
   * 예전에 자주 고른 후보가 방금 고른 후보를 계속 눌렀다.
   * MRU의 주 신호는 최근성이어야 한다.
   */
  it('방금 고른 후보가 예전에 여러 번 고른 후보보다 위로 온다', () => {
    const mru = new MruStore();
    const engine = new JieumEngine(createTierSnapshot(), { mru });

    // 政治를 예전에 다섯 번 골랐다
    for (let i = 0; i < 5; i++) engine.recordChoice('정치', '政治', 1000 + i);
    // 鼎峙는 방금 한 번 골랐다
    engine.recordChoice('정치', '鼎峙', 9000);

    const top = engine.lookup('정치')[0]!.candidates[0]!;
    expect(top.hanja).toBe('鼎峙');
  });

  it('최근성이 같으면 자주 고른 것이 위로 온다', () => {
    const mru = new MruStore();
    const engine = new JieumEngine(createTierSnapshot(), { mru });

    engine.recordChoice('정치', '定置', 5000);
    engine.recordChoice('정치', '定置', 5000);
    engine.recordChoice('정치', '情致', 5000);

    const hanja = engine.lookup('정치')[0]!.candidates.map((c) => c.hanja);
    expect(hanja.indexOf('定置')).toBeLessThan(hanja.indexOf('情致'));
  });

  it('고른 순서대로 줄을 세운다', () => {
    const mru = new MruStore();
    const engine = new JieumEngine(createTierSnapshot(), { mru });

    engine.recordChoice('정치', '情致', 1000);
    engine.recordChoice('정치', '定置', 2000);
    engine.recordChoice('정치', '鼎峙', 3000);

    const hanja = engine.lookup('정치')[0]!.candidates.map((c) => c.hanja);
    expect(hanja.slice(0, 3)).toEqual(['鼎峙', '定置', '情致']);
  });

  it('같은 후보를 다시 고르면 다시 맨 위로 온다', () => {
    const mru = new MruStore();
    const engine = new JieumEngine(createTierSnapshot(), { mru });

    engine.recordChoice('정치', '定置', 1000);
    engine.recordChoice('정치', '鼎峙', 2000);
    expect(engine.lookup('정치')[0]!.candidates[0]!.hanja).toBe('鼎峙');

    engine.recordChoice('정치', '定置', 3000);
    expect(engine.lookup('정치')[0]!.candidates[0]!.hanja).toBe('定置');
  });
});

/**
 * 연어(문맥 판별)
 *
 * 기획서 1번 차별점이자 한자한자에서 옮겨온 자산이다. 한자한자는 이 규칙으로
 * 한자를 확정하지만(자동 변환), 지음은 순위 보너스로만 쓴다 — 사용자가 고르는
 * 시스템에서는 후보를 지우는 것보다 순서를 바꾸는 편이 개입이 좁다.
 */
describe('연어 문맥 판별', () => {
  function collocationSnapshot(): DictSnapshot {
    return {
      dict: new Map([
        // 빈도상으로는 市場이 앞선다 — 문맥이 이것을 뒤집을 수 있어야 한다
        ['시장', [e('市場', 100), e('市長', 15)]],
        // 2층 후보가 섞인 자리 — 문맥이 맞아도 첫 줄로 끌어올리지 않는다
        ['전각', [e('殿閣', 40), { h: '篆刻', f: 10, l: 0, a: true }]],
      ]),
      compound: new Map(),
      blocklist: new Set(),
      collocation: new Map([
        ['시장', [
          { h: '市長', c: ['선거', '후보', '출마'] },
          { h: '市場', c: ['가격', '주식'] },
        ]],
        ['전각', [{ h: '篆刻', c: ['서예', '낙관'] }]],
      ]),
    };
  }

  it('문맥이 없으면 빈도 순위를 그대로 둔다', () => {
    const engine = new JieumEngine(collocationSnapshot());

    expect(engine.lookup('시장')[0]!.candidates[0]!.hanja).toBe('市場');
  });

  it('앞 문맥이 가리키는 한자를 위로 올린다', () => {
    const engine = new JieumEngine(collocationSnapshot());

    const top = engine.lookup('시장', '이번 지방선거에 후보로 출마한')[0]!.candidates[0]!;
    expect(top.hanja).toBe('市長');
    expect(top.collocation).toBeGreaterThan(0);
    expect(top.source).toBe('collocation');
  });

  it('문맥이 다르면 다른 한자를 올린다', () => {
    const engine = new JieumEngine(collocationSnapshot());

    expect(
      engine.lookup('시장', '주식 가격이 오르면서')[0]!.candidates[0]!.hanja,
    ).toBe('市場');
  });

  it('걸린 문맥어가 많을수록 점수가 높다', () => {
    const engine = new JieumEngine(collocationSnapshot());

    const one = engine.lookup('시장', '선거를 앞두고')[0]!.candidates[0]!;
    const three = engine.lookup('시장', '선거 후보로 출마한')[0]!.candidates[0]!;
    expect(three.score).toBeGreaterThan(one.score);
  });

  /**
   * 회귀 가드 — 연어 보너스(300)는 2층 감점(1000)을 넘지 않는다.
   *
   * 첫 조회는 사전 순서를 따르고, 이후에는 사용자 선택을 반영한다.
   * 규칙이 맞다고 고어·전문어를 첫 줄로 올리면 그 전제가 깨진다.
   */
  it('문맥이 맞아도 2층 후보를 첫 줄로 올리지 않는다', () => {
    const engine = new JieumEngine(collocationSnapshot());

    const groups = engine.lookup('전각', '서예 낙관을 새기는').filter((g) => g.word === '전각');
    expect(groups[0]!.candidates[0]!.hanja).toBe('殿閣');
    expect(groups[0]!.candidates.some((c) => c.hanja === '篆刻')).toBe(false);
  });

  /**
   * 사용 이력은 문맥마다 따로 담긴다 (Mozc의 bigram 학습에서 가져온 구조)
   *
   * 표제어 단위로 담으면 문맥마다 다른 한자를 쓰는 단어에서 학습이 오히려
   * 틀린다. `선거...시장`에서
   * 市長을 고르자 `주식 가격이 오르는 시장`까지 市長이 됐다.
   */
  describe('문맥별 사용 이력', () => {
    it('같은 문맥에서 고른 것이 그 문맥에서 1번이 된다', () => {
      const mru = new MruStore();
      const engine = new JieumEngine(collocationSnapshot(), { mru });

      engine.recordChoice('시장', '市長', 1000, '이번 선거에 출마한');
      expect(
        engine.lookup('시장', '이번 선거에 출마한')[0]!.candidates[0]!.hanja,
      ).toBe('市長');
    });

    /** 문맥별 이력 회귀 가드 */
    it('한 문맥에서 고른 것이 다른 문맥으로 번지지 않는다', () => {
      const mru = new MruStore();
      const engine = new JieumEngine(collocationSnapshot(), { mru });

      engine.recordChoice('시장', '市長', 1000, '이번 선거에 출마한');

      // 문맥이 바뀌면 연어 규칙이 다시 결정한다
      expect(
        engine.lookup('시장', '주식 가격이 오르는')[0]!.candidates[0]!.hanja,
      ).toBe('市場');
    });

    it('사용자가 규칙과 다르게 고르면 그 문맥에서 사용자가 이긴다', () => {
      const mru = new MruStore();
      const engine = new JieumEngine(collocationSnapshot(), { mru });

      // 연어는 이 문맥에서 市場을 지목하지만 사용자는 市長을 골랐다
      engine.recordChoice('시장', '市長', 1000, '주식 가격이 오르는');
      expect(
        engine.lookup('시장', '주식 가격이 오르는')[0]!.candidates[0]!.hanja,
      ).toBe('市長');
    });

    /**
     * 문맥 없이 고른 이력은 문맥이 붙어도 살아남는다.
     *
     * 폴백이 없으면 문서 첫 줄에서 고른 것이 영영 안 쓰인다 — 그때는 문맥이
     * 없어 표제어 칸에 들어가는데, 나중에 문맥이 생기면 그 칸을 안 보게 된다.
     */
    it('문맥 없이 고른 이력은 문맥 칸이 비었을 때 쓰인다', () => {
      const mru = new MruStore();
      const engine = new JieumEngine(collocationSnapshot(), { mru });

      engine.recordChoice('시장', '市長', 1000);
      expect(
        engine.lookup('시장', '주식 가격이 오르는')[0]!.candidates[0]!.hanja,
      ).toBe('市長');
    });
  });

  /**
   * 조회와 확정이 프로세스를 사이에 두고 떨어져 있을 때를 위한 계약
   *
   * 입력기 셸은 조합 중에 조회하고 사용자가 고른 뒤에 확정한다. 그 사이에 커서가
   * 움직였을 수 있으므로 확정 시점에 앞 문맥을 다시 읽으면 안 된다 — 조회가 쓴
   * 문맥 키를 그대로 들고 와야 한다.
   */
  describe('문맥 키 왕복 (입력기 셸 계약)', () => {
    it('조회가 그룹마다 문맥 키를 함께 낸다', () => {
      const engine = new JieumEngine(collocationSnapshot());

      const withContext = engine.lookup('시장', '이번 선거에 출마한');
      expect(withContext[0]!.contextKey).toBe('市長');

      const other = engine.lookup('시장', '주식 가격이 오르는');
      expect(other[0]!.contextKey).toBe('市場');
    });

    it('연어가 안 걸리면 문맥 키가 비어 있다 (표제어 단위 학습으로 돌아간다)', () => {
      const engine = new JieumEngine(collocationSnapshot());
      expect(engine.lookup('시장')[0]!.contextKey).toBeUndefined();
    });

    /**
     * 회귀 가드 — 이 등가가 깨지면 "방금 고른 것이 다음 조회에서 사라진다"가 된다.
     * 랭킹이 보는 키와 이력이 쌓이는 키가 같은 값에서 나와야 성립한다.
     */
    it('조회가 준 키로 기록하면 문맥을 다시 읽은 것과 같은 결과가 된다', () => {
      const context = '이번 선거에 출마한';

      const viaKey = new MruStore();
      const engineA = new JieumEngine(collocationSnapshot(), { mru: viaKey });
      const key = engineA.lookup('시장', context)[0]!.contextKey;
      engineA.recordChoiceWithContextKey('시장', '市長', key, 1000);

      const viaContext = new MruStore();
      const engineB = new JieumEngine(collocationSnapshot(), { mru: viaContext });
      engineB.recordChoice('시장', '市長', 1000, context);

      expect(viaKey.toJSON()).toEqual(viaContext.toJSON());
    });

    it('확정 뒤 문맥이 바뀌어도 고른 문맥에는 남고 다른 문맥에는 번지지 않는다', () => {
      const mru = new MruStore();
      const engine = new JieumEngine(collocationSnapshot(), { mru });

      // 조회 시점의 문맥 키를 들고 있다가...
      const key = engine.lookup('시장', '이번 선거에 출마한')[0]!.contextKey;
      // ...확정 시점에는 문맥이 이미 달라져 있다 (커서가 움직였다)
      engine.recordChoiceWithContextKey('시장', '市長', key, 1000);

      expect(
        engine.lookup('시장', '이번 선거에 출마한')[0]!.candidates[0]!.hanja,
      ).toBe('市長');
      expect(
        engine.lookup('시장', '주식 가격이 오르는')[0]!.candidates[0]!.hanja,
      ).toBe('市場');
    });
  });

  it('연어 사전이 없어도 동작한다', () => {
    const snapshot = collocationSnapshot();
    delete snapshot.collocation;
    const engine = new JieumEngine(snapshot);

    expect(engine.lookup('시장', '선거 후보')[0]!.candidates[0]!.hanja).toBe('市場');
  });
});

describe('지나간 표제어는 후보에서 뺀다', () => {
  function tailSnapshot(): DictSnapshot {
    return {
      dict: new Map([
        ['말', [e('末', 90), e('馬', 40)]],
        ['후보', [e('候補', 100)]],
        ['발전', [e('發展', 120)]],
        ['발전소', [e('發電所', 80)]],
      ]),
      compound: new Map(),
      blocklist: new Set(),
    };
  }

  function words(text: string): string[] {
    return new JieumEngine(tailSnapshot()).lookup(text).map((g) => g.word);
  }

  it('표제어를 지나쳐 계속 치면 그 후보가 사라진다', () => {
    // "말러9번"을 치면 "妺러번"이 되던 회귀.
    // "말러"까지 쳤는데 "말"의 후보가 떠 있었고, 이어서 누른 9가 숫자가 아니라
    // 9번 후보 확정으로 먹혔다. 후보가 없으면 그 키는 셸을 그냥 통과한다.
    expect(words('말')).toEqual(['말']);
    expect(words('말러')).toEqual([]);

    // "후보라고"까지 쳐도 候補가 계속 보이던 회귀
    expect(words('후보라고')).toEqual([]);
  });

  it('조사·어미가 붙은 것은 표제어가 살아 있는 것이다', () => {
    // 한국어에서 명사는 거의 항상 조사를 달고 나온다. 여기서 후보를 숨기면
    // 조사를 붙이는 순간 한자 변환이 통째로 불가능해진다.
    expect(words('발전소를')).toEqual(['발전소']);
    expect(words('발전은')).toEqual(['발전']);
    expect(words('발전하다')).toEqual(['발전']);
  });

  it('조합 중인 낱자는 아직 판단하지 않는다', () => {
    // "발전ㅅ"에서 숨겨 버리면 발전→발전ㅅ→발전소를 치는 동안 후보창이 깜빡인다
    expect(words('발전ㅅ')).toEqual(['발전']);
  });

  it('더 긴 표제어가 완성되면 짧은 쪽은 물러난다', () => {
    // "발전소"를 다 쳤는데 "발전"이 남아 있으면, 고르려던 것이 아닌 후보가
    // 숫자키 사정거리 안에 계속 머문다
    expect(words('발전')).toEqual(['발전']);
    expect(words('발전소')).toEqual(['발전소']);
  });
});

describe('사용자 조합 학습', () => {
  it('조합한 어휘가 맨 위에 온다', () => {
    const engine = new JieumEngine(createTestSnapshot());
    const store = new UserWordStore();
    store.record('김홍경', '金洪京', Date.now());
    engine.setUserWords(store);

    const results = engine.lookup('김홍경');
    expect(results[0]!.word).toBe('김홍경');
    expect(results[0]!.candidates[0]!.hanja).toBe('金洪京');
    expect(results[0]!.candidates[0]!.source).toBe('user');
  });

  it('저장소가 비어 있으면 예전과 똑같이 동작한다', () => {
    const engine = new JieumEngine(createTestSnapshot());
    const before = engine.lookup('발전소');
    engine.setUserWords(new UserWordStore());
    expect(engine.lookup('발전소')).toEqual(before);
  });

  it('사전에 있는 표제어와 겹쳐도 사용자 조합이 먼저다', () => {
    const engine = new JieumEngine(createTestSnapshot());
    const store = new UserWordStore();
    store.record('경제', '經齊', Date.now()); // 일부러 사전과 다른 조합
    engine.setUserWords(store);

    const results = engine.lookup('경제');
    expect(results[0]!.candidates[0]!.hanja).toBe('經齊');
    // 사전 후보가 사라지지는 않는다
    const all = results.flatMap((r) => r.candidates).map((c) => c.hanja);
    expect(all).toContain('經濟');
  });

  it('지운 조합은 다시 안 나온다', () => {
    const engine = new JieumEngine(createTestSnapshot());
    const store = new UserWordStore();
    store.record('김홍경', '金洪京', Date.now());
    engine.setUserWords(store);
    expect(engine.forgetUserWord('김홍경', '金洪京')).toBe(true);
    expect(engine.lookup('김홍경').some((r) => r.word === '김홍경')).toBe(false);
  });

  it('블록리스트에 걸린 것은 사용자 조합이어도 안 낸다', () => {
    const engine = new JieumEngine(createTestSnapshot());
    const store = new UserWordStore();
    store.record('나라', '那羅', Date.now()); // createTestSnapshot의 블록리스트
    engine.setUserWords(store);
    expect(engine.lookup('나라').some((r) => r.word === '나라')).toBe(false);
  });

  it('엔진을 거쳐 기록하면 다음 조회에서 나온다', () => {
    const engine = new JieumEngine(createTestSnapshot());
    engine.setUserWords(new UserWordStore());
    engine.recordUserWord('이순신', '李舜臣');
    expect(engine.lookup('이순신')[0]!.candidates[0]!.hanja).toBe('李舜臣');
  });
});
