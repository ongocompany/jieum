import { DECAY_TICKS } from './mru.js';

/**
 * 사용자가 조합해 만든 어휘
 *
 * 사용자가 낱자를 하나씩 확정해 만든 한자 조합(`김`→金, `홍`→洪, `경`→京)을 담는다.
 * 다음에 `김홍경`을 치면 `金洪京`이 통째로 나온다.
 *
 * ## 왜 사전 Trie가 아니라 별도 저장소인가
 *
 * `packages/engine-server`는 `jieum-dict.dat`를 메모리로 펼치지 않고 읽는다(RSS 58.9MB).
 * 그 대가로 조회기가 **읽기 전용**이라 사용자 어휘를 Trie에 넣을 수 없다.
 *
 * 처음엔 어쩔 수 없이 택한 우회로로 보였는데, 조사해 보니 **참조 구현이 전부 그렇게 한다**
 * — Rime·libime·libpinyin·sunpinyin 모두 사용자 어휘를 시스템 사전과 **다른 저장소**에
 * 두고 조회 시점에 합친다. Rime의 `UserDictionary`는 자기 `db_`를 갖고,
 * `ScriptTranslation::Evaluate`가 `dict->Lookup`과 `user_dict->Lookup`을 따로 부른다.
 *
 * ## 왜 지우지 않고 감쇠만 하는가
 *
 * Mozc의 자동 청소(`MaybeRemoveUnselectedHistory`)는 매력적이지만 그것은 **이력 예측기의
 * 것이지 사용자 사전의 것이 아니다.** Rime·libime·libpinyin·sunpinyin에서 감쇠는
 * 이력/n-gram 저장소에 걸리고 사용자 사전은 사용자가 지울 때까지 남는다.
 *
 * 신뢰의 문제다. **사용자가 손으로 만든 것**을 조용히 지우는 것은 「지웠는데 또 나온다」의
 * 거울상이고 — 「만들었는데 사라졌다」 — 사용자가 수고를 한 만큼 더 나쁘다.
 * 그래서 순위는 내려가되(`strength`) 기록은 남는다. 찾을 수 있고, 지울 수 있다.
 *
 * 저장 크기는 실제로 문제가 안 된다 — 사람마다 조합은 수천 개 규모이고,
 * 오늘 `mru.json`이 140건에 5.4KB다.
 *
 * 설계 전문: `docs/08-user-word-learning-plan.md`
 */

/** 조합 하나 (조회 결과) */
export interface UserWordEntry {
  /** 조합된 한글 (예: `김홍경`) */
  reading: string;
  /** 조합된 한자 (예: `金洪京`) */
  hanja: string;
  /** 만들거나 쓴 횟수 */
  count: number;
  /** 감쇠가 적용된 강도 */
  strength: number;
}

/** 파일로 남는 모양 */
export interface UserWordSnapshot {
  v: 1;
  tick: number;
  records: Record<string, [count: number, lastUsed: number, strength: number, tick: number]>;
}

/**
 * 담을 수 있는 조합 수. 넘으면 가장 약한 것부터 버린다.
 *
 * Mozc의 `kLruCacheSize`(10,000, ~700KB)와 같은 값이다.
 */
export const USER_WORD_CAPACITY = 10000;

/**
 * 한글·한자 각각의 길이 상한 (바이트)
 *
 * Mozc의 `kMaxStringLength`와 같다. ⚠️ **음절 수 상한은 두지 않는다** — libime도
 * 전부 낱자로 이뤄진 연속에는 상한을 걸지 않는다. 상한을 두면 긴 인명이 잘린다.
 */
export const MAX_FIELD_BYTES = 256;

/** 접두사를 찾을 때 훑는 최대 음절 수. 이보다 긴 조합은 접두사 조회에 안 걸린다 */
const MAX_PREFIX_SYLLABLES = 32;

interface UserWordRecord {
  count: number;
  lastUsed: number;
  strength: number;
  tick: number;
}

const encoder = new TextEncoder();

export class UserWordStore {
  /** 한글 → (한자 → 기록). 접두사 조회를 상수 시간으로 만들기 위한 배치다 */
  private byReading = new Map<string, Map<string, UserWordRecord>>();
  private ticks = 0;

  constructor(private readonly capacity = USER_WORD_CAPACITY) {}

  /**
   * 조합을 기록한다. 이미 있으면 횟수와 강도를 올린다.
   *
   * 길이 상한을 넘으면 **조용히 버린다** — 배우지 않는 것이 잘못 배우는 것보다 낫고,
   * 사용자에게 알릴 것도 없다(그가 한 일은 글자를 친 것뿐이다).
   */
  record(reading: string, hanja: string, now: number): void {
    if (!reading || !hanja) return;
    if (encoder.encode(reading).length > MAX_FIELD_BYTES) return;
    if (encoder.encode(hanja).length > MAX_FIELD_BYTES) return;

    this.ticks++;
    const slot = this.byReading.get(reading) ?? new Map<string, UserWordRecord>();
    const existing = slot.get(hanja);
    if (existing) {
      existing.count++;
      existing.lastUsed = now;
      existing.strength = this.decayed(existing) + 1;
      existing.tick = this.ticks;
    } else {
      slot.set(hanja, { count: 1, lastUsed: now, strength: 1, tick: this.ticks });
    }
    this.byReading.set(reading, slot);
    this.evictIfNeeded();
  }

  /** 시간이 지난 만큼 깎인 강도 (Rime `formula_d`, MRU와 같은 공식) */
  private decayed(record: UserWordRecord): number {
    const age = this.ticks - record.tick;
    return (record.strength * DECAY_TICKS) / (DECAY_TICKS + age);
  }

  /**
   * `text`의 **접두사**와 일치하는 조합들.
   *
   * 긴 것이 먼저, 같은 길이면 강한 것이 먼저다. 아직 치는 중에도 걸려야 하므로
   * 완전 일치가 아니라 접두사로 찾는다 — `김홍경을`을 치는 중에도 `김홍경`이 나와야 한다.
   */
  prefixMatches(text: string): UserWordEntry[] {
    if (!text) return [];
    const out: UserWordEntry[] = [];
    const max = Math.min(text.length, MAX_PREFIX_SYLLABLES);
    for (let n = max; n >= 1; n--) {
      const reading = text.slice(0, n);
      const slot = this.byReading.get(reading);
      if (!slot) continue;
      const group: UserWordEntry[] = [];
      for (const [hanja, record] of slot) {
        group.push({ reading, hanja, count: record.count, strength: this.decayed(record) });
      }
      group.sort((a, b) => b.strength - a.strength);
      out.push(...group);
    }
    return out;
  }

  /** 사용자가 손으로 지운다. 지웠으면 `true` */
  forget(reading: string, hanja: string): boolean {
    const slot = this.byReading.get(reading);
    if (!slot?.delete(hanja)) return false;
    if (slot.size === 0) this.byReading.delete(reading);
    return true;
  }

  get size(): number {
    let n = 0;
    for (const slot of this.byReading.values()) n += slot.size;
    return n;
  }

  private evictIfNeeded(): void {
    if (this.size <= this.capacity) return;
    let weakestReading: string | undefined;
    let weakestHanja: string | undefined;
    let weakest = Infinity;
    for (const [reading, slot] of this.byReading) {
      for (const [hanja, record] of slot) {
        const strength = this.decayed(record);
        if (strength < weakest) {
          weakest = strength;
          weakestReading = reading;
          weakestHanja = hanja;
        }
      }
    }
    if (weakestReading !== undefined && weakestHanja !== undefined) {
      this.forget(weakestReading, weakestHanja);
    }
  }

  toJSON(): UserWordSnapshot {
    const records: UserWordSnapshot['records'] = {};
    for (const [reading, slot] of this.byReading) {
      for (const [hanja, r] of slot) {
        records[`${reading}\t${hanja}`] = [r.count, r.lastUsed, r.strength, r.tick];
      }
    }
    return { v: 1, tick: this.ticks, records };
  }

  /**
   * 파일에서 되읽는다.
   *
   * 모양이 안 맞으면 **빈 저장소**를 낸다. 반쪽 파일에 죽는 것보다 배운 것을 잃는 편이
   * 낫다 — 입력기가 안 뜨는 것이 가장 나쁘다.
   */
  static fromJSON(snapshot: unknown, capacity?: number): UserWordStore {
    const store = new UserWordStore(capacity);
    if (!snapshot || typeof snapshot !== 'object') return store;
    const obj = snapshot as Partial<UserWordSnapshot>;
    if (obj.v !== 1 || !obj.records || typeof obj.records !== 'object') return store;

    store.ticks = typeof obj.tick === 'number' ? obj.tick : 0;
    for (const [key, value] of Object.entries(obj.records)) {
      if (!Array.isArray(value) || value.length < 4) continue;
      const [count, lastUsed, strength, tick] = value;
      if (
        typeof count !== 'number' ||
        typeof lastUsed !== 'number' ||
        typeof strength !== 'number' ||
        typeof tick !== 'number'
      ) {
        continue;
      }
      const tab = key.indexOf('\t');
      if (tab <= 0) continue;
      const reading = key.slice(0, tab);
      const hanja = key.slice(tab + 1);
      if (!reading || !hanja) continue;
      const slot = store.byReading.get(reading) ?? new Map<string, UserWordRecord>();
      slot.set(hanja, { count, lastUsed, strength, tick });
      store.byReading.set(reading, slot);
    }
    return store;
  }
}
