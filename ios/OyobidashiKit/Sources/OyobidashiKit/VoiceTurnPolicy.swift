import Foundation

/// Monotonic timing and cancellable sleeps keep retries bounded and tests deterministic.
public struct VoiceTurnPolicy: Sendable {
    public var overallTimeout: TimeInterval
    public var maxPostAttempts: Int
    public var now: @Sendable () -> TimeInterval
    public var sleep: @Sendable (TimeInterval) async throws -> Void

    public init(
        overallTimeout: TimeInterval = 95,
        maxPostAttempts: Int = 3,
        now: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
        sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { seconds in
            try await Task.sleep(for: .seconds(seconds))
        }
    ) {
        self.overallTimeout = overallTimeout.isFinite && overallTimeout > 0 ? overallTimeout : 95
        self.maxPostAttempts = min(5, max(1, maxPostAttempts))
        self.now = now
        self.sleep = sleep
    }
}
