import OyobidashiKit
import UserNotifications

/// Cloud pushes contain generic fallback text. A short-lived capability restores
/// the current recipient's question/actions without sharing account credentials.
final class NotificationService: UNNotificationServiceExtension {
    private let lock = NSLock()
    private var finish: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNMutableNotificationContent?
    private var previewTask: Task<Void, Never>?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        finish = contentHandler
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else { contentHandler(request.content); return }
        let descriptor = NotificationPreviewDescriptor(userInfo: content.userInfo)
        let scoped = content.userInfo["recipient_device_id"] != nil
        if scoped {
            // This safe fallback also covers revoked/malformed/expired capabilities,
            // network failure and the OS terminating the extension's time budget.
            content.title = NotificationPreviewPrivacy.title
            content.subtitle = ""
            content.body = NotificationPreviewPrivacy.body
            content.attachments = []
            content.categoryIdentifier = PushCategory.notification
            content.userInfo = NotificationPreviewPrivacy.safeUserInfo(content.userInfo)
        }
        bestAttempt = content
        guard scoped else { registerChoicesAndComplete(content); return }
        guard let descriptor else { complete(content); return }
        previewTask = Task { [weak self] in
            do {
                let current = try await NotificationPreviewClient().fetch(descriptor)
                guard !Task.isCancelled, let self,
                      let enriched = content.mutableCopy() as? UNMutableNotificationContent else { return }
                enriched.userInfo["status"] = current.status.rawValue
                enriched.userInfo["kind"] = current.kind.rawValue
                if NotificationPolicy.shouldPresent(request: current) {
                    enriched.title = NotificationText.title(for: current)
                    enriched.body = NotificationText.body(for: current)
                    enriched.userInfo["delivery_mode"] = current.deliveryMode.rawValue
                    if current.isActionsEligible {
                        enriched.userInfo["choices"] = current.effectiveChoices
                    }
                    if current.kind == .notification {
                        enriched.categoryIdentifier = PushCategory.notification
                    } else {
                        enriched.categoryIdentifier = current.items == nil ? PushCategory.question : PushCategory.itemQuestion
                    }
                } else {
                    enriched.body = "この質問は終了しました"
                    enriched.sound = nil
                    enriched.categoryIdentifier = PushCategory.notification
                }
                self.registerChoicesAndComplete(enriched)
            } catch {
                guard !Task.isCancelled else { return }
                self?.complete(content)
            }
        }
    }

    private func registerChoicesAndComplete(_ content: UNMutableNotificationContent) {
        guard content.userInfo["delivery_mode"] as? String == "actions",
              let id = content.userInfo["request_id"] as? String,
              let choices = content.userInfo["choices"] as? [String], (1...3).contains(choices.count) else {
            complete(content)
            return
        }
        let center = UNUserNotificationCenter.current()
        center.getNotificationCategories { [weak self] categories in
            guard let self else { return }
            let categoryID = "OYOBIDASHI_ACTIONS_\(id)"
            let actions = choices.enumerated().map { index, title in
                UNNotificationAction(identifier: "OYOBIDASHI_CHOICE_\(index)", title: title, options: [])
            }
            var merged = categories
            merged.insert(UNNotificationCategory(identifier: categoryID, actions: actions, intentIdentifiers: [], options: []))
            center.setNotificationCategories(merged)
            content.categoryIdentifier = categoryID
            self.complete(content)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        previewTask?.cancel()
        if let bestAttempt { complete(bestAttempt) }
    }

    private func complete(_ content: UNNotificationContent) {
        lock.lock()
        let handler = finish
        finish = nil
        lock.unlock()
        handler?(content)
    }
}
