/**
 * 최근 변환 이력 (MRU)
 *
 * 지음 사전은 628,766 엔트리 중 97.6%가 빈도 0이다. 데이터 한계이지 버그가
 * 아니며, 빈도를 새로 수집할 방법도 마땅치 않다. 그래서 **사용자 자신의
 * 선택**을 1순위 랭킹 신호로 쓴다.
 *
 * 2층 구분은 첫 노출을 보수적으로 잡고, MRU는 실제 선택에 따라 사용자별로
 * 순서를 바꾼다. 따라서 MRU 보너스는 2층 감점보다 커야 한다.
 *
 * 거부는 다루지 않는다. 계약상 거부는 영구 차단이 아니라 음의 신호로만 쓰기로
 * 했고(망라형 유지와 양립), 1차에서는 수락만으로 충분한지 먼저 본다.
 *
 * core는 플랫폼 독립이므로 저장소를 여기서 정하지 않는다. 이 모듈은 메모리
 * 표현과 직렬화만 담당하고, 어디에 어떤 범위로 남길지는 호출자가 정한다.
 */

/** 한 후보에 대한 사용 이력 */
export interface MruRecord {
  /** 고른 횟수 (진단·표시용. 점수에는 {@link MruRecord.dee}를 쓴다) */
  count: number;
  /** 마지막으로 고른 시각 (epoch ms) */
  at: number;
  /**
   * 감쇠된 사용량.
   *
   * 확정할 때마다 `1 + 옛값 × exp(경과 / DECAY_TICKS)`로 눌러 담는다. 단순히 횟수를
   * 경과로 나누는 것과 다르다 — "옛날에 10번, 최근에 1번"과 "최근에 3번"이 이렇게
   * 해야 구분된다. Rime(librime `algo/dynamics.h`의 `formula_d`)에서 가져왔다.
   */
  dee: number;
  /** 마지막으로 갱신된 시점 (전역 tick — 확정 횟수) */
  tick: number;
}

/**
 * 직렬화 형태.
 *
 * 옛 형식(`Record<키, [횟수, 시각]>`)도 읽어 기존 사용자 이력을 보존한다.
 */
export interface MruSnapshot {
  v: 2;
  /** 전역 tick — 확정 횟수 */
  tick: number;
  /** "표제어\t한자[\t문맥]" → [횟수, 시각, 감쇠사용량, tick] */
  records: Record<string, [number, number, number, number]>;
}

/** 이력의 옛 직렬화 형태 */
type MruSnapshotV1 = Record<string, [number, number]>;

/**
 * 감쇠 시상수 — **이 횟수만큼 다른 글자를 확정하면 옛 기록이 1/e(약 37%)로 준다.**
 *
 * 날짜가 아니라 **확정 횟수**를 세는 것이 요점이다. 한 달 쉬었다고 이력이 날아가면
 * 안 되고, 반대로 하루에 논문 한 편을 쓰면 그만큼 옛 어휘가 밀려나야 한다. 흐려지는
 * 속도가 사용자의 실제 타이핑 양을 따라간다.
 *
 * 200은 Rime이 쓰는 값이다. 우리 사용 양상에 맞는지는 실사용으로 조정한다.
 */
export const DECAY_TICKS = 200;

/**
 * 이 아래로 흐려지면 **이력이 없는 것으로 친다.**
 *
 * 잊는 것이 왜 필요한가: 이력이 있으면 랭커가 2층(고어·전문어) 감점을 면제한다.
 * 1년 전에 한 번 고른 고어가 그 면제를 영원히 들고 있으면, 오늘 처음 보는 현대어보다
 * 계속 위에 온다. 잊혀야 그 감점이 제자리로 돌아온다.
 *
 * 0.02면 약 780번의 다른 확정을 거쳐 잊힌다 (`ln(1/0.02) × 200`).
 */
export const FORGET_THRESHOLD = 0.02;

/** 랭킹에 넘기는 이력 한 건 */
export interface MruStrength {
  count: number;
  at: number;
  /** 지금 시점으로 흐려진 사용량 */
  strength: number;
}

/**
 * 최근 변환 이력 저장소
 *
 * 표제어+한자 쌍 단위로 센다. 표제어만으로는 부족하다 — "정치"에서 政治를
 * 골랐다는 사실이 "정"에서 政을 고르는 데까지 번지면 안 된다.
 *
 * 여기에 **문맥**을 한 축 더 둔다. 문맥마다 다른 한자를 쓰는 단어에서는
 * 표제어 단위 학습이 오히려 틀린다. `선거...시장`에서 市長을 고른 이력이
 * `주식...시장`까지 따라오면 문맥 판별이 무력해진다.
 *
 * 이 구조는 Mozc(구글 일본어 입력)에서 가져왔다. Mozc는 이력을 표제어가
 * 아니라 bigram(앞 항목 → 이 항목) 링크로 저장해 같은 문제를 푼다.
 * 지음은 앞 단어 대신 **연어 규칙이 지목한 한자**를 문맥 키로 쓴다 —
 * 문맥어 145,964개가 이미 "이 문맥은 어느 쪽"으로 요약돼 있어서, 앞 단어
 * 하나보다 넓은 범위를 한 글자로 담는다.
 *
 * 문맥 키가 비면(연어 규칙이 없는 표제어 — 사전의 97.7%) 예전과 똑같이
 * 표제어 단위로 동작한다.
 */
export class MruStore {
  private records = new Map<string, MruRecord>();

  /**
   * 전역 tick — 확정 횟수. 확정할 때마다 1씩 오른다.
   *
   * 감쇠의 기준이 시간이 아니라 이것이다 — 자세한 것은 {@link DECAY_TICKS}.
   */
  private tick = 0;

  /** 보관할 최대 항목 수 — 넘으면 가장 오래된 것부터 버린다 */
  constructor(private readonly capacity = 5000) {}

  private static key(word: string, hanja: string, context?: string): string {
    return context ? `${word}\t${hanja}\t${context}` : `${word}\t${hanja}`;
  }

  /**
   * 문맥 칸을 먼저 보고, 없으면 표제어 칸으로 물러난다
   *
   * 폴백이 없으면 문맥 없이 고른 이력이 영영 안 쓰인다 — 문서 첫 줄에서
   * 고른 것은 문맥이 없어 표제어 칸에 들어가는데, 나중에 문맥이 붙는
   * 순간 그 칸을 안 보게 되기 때문이다.
   *
   * 반대 방향으로는 새지 않는다. 문맥이 있을 때는 문맥 칸에만 적으므로
   * `선거...시장`에서 고른 市長이 `주식...시장`으로 번지지 않는다.
   */
  get(word: string, hanja: string, context?: string): MruStrength | undefined {
    let record: MruRecord | undefined;
    if (context) {
      record = this.records.get(MruStore.key(word, hanja, context));
    }
    record ??= this.records.get(MruStore.key(word, hanja));
    if (!record) return undefined;

    const strength = this.decayed(record);
    // 다 흐려진 것은 없는 것과 같다. 여기서 걸러야 랭커가 2층 감점 면제를
    // 영원히 물고 있지 않는다.
    if (strength < FORGET_THRESHOLD) return undefined;

    return { count: record.count, at: record.at, strength };
  }

  /** 지금 tick 기준으로 흐려진 사용량 */
  private decayed(record: MruRecord): number {
    return record.dee * Math.exp((record.tick - this.tick) / DECAY_TICKS);
  }

  /** 사용자가 후보를 확정했을 때 호출한다 */
  record(word: string, hanja: string, now: number, context?: string): void {
    if (!word || !hanja) return;

    // tick은 **무엇을 골랐든** 오른다. 이 한 번이 다른 모든 이력을 그만큼 흐리게 한다.
    this.tick += 1;

    const key = MruStore.key(word, hanja, context);
    const existing = this.records.get(key);

    if (existing) {
      // 옛 값을 지금 시점으로 끌어와 흐리게 한 뒤 이번 한 번을 더한다.
      existing.dee = 1 + this.decayed(existing);
      existing.count += 1;
      existing.at = now;
      existing.tick = this.tick;
      return;
    }

    this.records.set(key, { count: 1, at: now, dee: 1, tick: this.tick });
    this.evictIfNeeded();
  }

  /**
   * 용량을 넘으면 가장 오래 안 쓴 것부터 버린다.
   *
   * 횟수가 아니라 시각으로 버리는 이유: 예전에 자주 쓰던 어휘보다 최근에 쓰는
   * 어휘가 지금 쓰는 글에 가깝다. 논문 한 편을 쓰는 동안의 어휘 집합이
   * 그 다음 글에서 통째로 바뀌는 것이 이 프로젝트의 실제 사용 양상이다.
   */
  private evictIfNeeded(): void {
    if (this.records.size <= this.capacity) return;

    const sorted = [...this.records.entries()].sort((a, b) => a[1].at - b[1].at);
    const excess = this.records.size - this.capacity;
    for (let i = 0; i < excess; i++) {
      this.records.delete(sorted[i]![0]);
    }
  }

  get size(): number {
    return this.records.size;
  }

  clear(): void {
    this.records.clear();
  }

  toJSON(): MruSnapshot {
    const records: MruSnapshot['records'] = {};
    for (const [key, record] of this.records) {
      records[key] = [record.count, record.at, record.dee, record.tick];
    }
    return { v: 2, tick: this.tick, records };
  }

  /**
   * 저장해 둔 스냅샷에서 복원한다. 형태가 어긋난 항목은 조용히 버린다.
   *
   * **옛 형식(감쇠가 없던 시절)도 읽는다.** 그때는 tick이 없었으므로 전부 "방금 쓴 것"
   * 으로 놓는다 — 감쇠를 도입했다는 이유로 그동안 쌓인 이력을 날리면 안 된다. 앞으로
   * 쓰는 만큼 자연히 흐려진다.
   */
  static fromJSON(snapshot: unknown, capacity?: number): MruStore {
    const store = new MruStore(capacity);
    if (!snapshot || typeof snapshot !== 'object') return store;

    const asV2 = snapshot as Partial<MruSnapshot>;
    if (asV2.v === 2 && asV2.records && typeof asV2.records === 'object') {
      store.tick = typeof asV2.tick === 'number' ? asV2.tick : 0;
      for (const [key, value] of Object.entries(asV2.records)) {
        if (!Array.isArray(value) || value.length !== 4) continue;
        const [count, at, dee, tick] = value;
        if (![count, at, dee, tick].every((n) => typeof n === 'number')) continue;
        if (!key.includes('\t')) continue;
        store.records.set(key, { count, at, dee, tick });
      }
      store.evictIfNeeded();
      return store;
    }

    // 옛 형식 — tick 0에서 시작하고 모든 기록을 그 자리에 놓는다.
    for (const [key, value] of Object.entries(snapshot as MruSnapshotV1)) {
      if (!Array.isArray(value) || value.length !== 2) continue;
      const [count, at] = value;
      if (typeof count !== 'number' || typeof at !== 'number') continue;
      if (!key.includes('\t')) continue;
      // 그동안 쌓인 횟수를 감쇠 사용량의 출발값으로 삼는다.
      store.records.set(key, { count, at, dee: count, tick: 0 });
    }

    store.evictIfNeeded();
    return store;
  }
}
