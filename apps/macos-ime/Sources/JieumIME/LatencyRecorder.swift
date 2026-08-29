import Foundation

/**
 왕복 지연 표본 기록기 (C0.3)

 게이트는 평균이 아니라 **p99**로 잡혀 있다. 입력기에서 문제가 되는 것은 평소가
 아니라 가끔 걸리는 순간이기 때문이다 — 평균 0.1ms라도 100번에 한 번 200ms가
 걸리면 사용자는 "가끔 버벅인다"고 느낀다.
 */
final class LatencyRecorder {
    private let lock = NSLock()
    private var samples: [Double] = []
    /// 오래 돌아도 메모리가 늘지 않게 상한을 둔다 (넘으면 앞을 버린다)
    private let capacity: Int

    init(capacity: Int = 20_000) {
        self.capacity = capacity
        samples.reserveCapacity(min(capacity, 4096))
    }

    func record(_ milliseconds: Double) {
        lock.lock()
        defer { lock.unlock() }
        samples.append(milliseconds)
        if samples.count > capacity {
            samples.removeFirst(samples.count - capacity)
        }
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return samples.count
    }

    struct Summary {
        let count: Int
        let p50: Double
        let p90: Double
        let p99: Double
        let max: Double
        let mean: Double

        /// C0.3 게이트
        var passesGate: Bool { p99 < 5.0 }

        var description: String {
            String(
                format: "n=%d p50=%.3fms p90=%.3fms p99=%.3fms max=%.3fms mean=%.3fms → C0.3 %@",
                count, p50, p90, p99, max, mean, passesGate ? "통과" : "실패")
        }
    }

    func summarize() -> Summary {
        lock.lock()
        let sorted = samples.sorted()
        lock.unlock()

        guard !sorted.isEmpty else {
            return Summary(count: 0, p50: 0, p90: 0, p99: 0, max: 0, mean: 0)
        }

        func percentile(_ p: Double) -> Double {
            let index = Int(ceil(p / 100 * Double(sorted.count))) - 1
            return sorted[Swift.min(sorted.count - 1, Swift.max(0, index))]
        }

        return Summary(
            count: sorted.count,
            p50: percentile(50),
            p90: percentile(90),
            p99: percentile(99),
            max: sorted[sorted.count - 1],
            mean: sorted.reduce(0, +) / Double(sorted.count)
        )
    }

    func reset() {
        lock.lock()
        samples.removeAll(keepingCapacity: true)
        lock.unlock()
    }
}
