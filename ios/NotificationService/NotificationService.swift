import UserNotifications

/// APNs can arrive before the containing app has seen this question. Register exact
/// choice labels here so a cold/background notification has the same buttons as a live one.
final class NotificationService: UNNotificationServiceExtension {
    private let lock = NSLock()
    private var finish: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        finish = contentHandler
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else { contentHandler(request.content); return }
        bestAttempt = content
        guard content.userInfo["delivery_mode"] as? String == "actions",
              let id = content.userInfo["request_id"] as? String,
              let choices = content.userInfo["choices"] as? [String], (1...3).contains(choices.count) else {
            complete(content)
            return
        }
        let center = UNUserNotificationCenter.current()
        center.getNotificationCategories { [weak self] categories in
            guard let self else { contentHandler(content); return }
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
