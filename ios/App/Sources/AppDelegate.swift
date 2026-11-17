import OyobidashiKit
import UIKit
import UserNotifications

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // 通知から (バックグラウンドで) 起動された場合もここを通るので、delegate とカテゴリは必ず起動時に設定する。
        AppEnvironment.shared.notifications.install()
        // トークン取得自体は許可ダイアログ無しでできる。通知の許可はペアリング後の画面で求める。
        application.registerForRemoteNotifications()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = APNsToken.hexString(from: deviceToken)
        Task { await AppEnvironment.shared.model.setPushToken(token) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Push 無しでもアプリ起動中は WebSocket で受け取れる。
        NSLog("oyobidashi: failed to register for remote notifications: %@", String(describing: error))
    }
    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any], fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        Task { @MainActor in
            let environment = AppEnvironment.shared
            guard PushRecipient(userInfo: userInfo).matches(currentDeviceID: environment.model.credentials?.deviceID) else {
                if let id = userInfo["request_id"] as? String { environment.notifications.removeDelivered(requestIDs: [id]) }
                completionHandler(.noData)
                return
            }
            if let id = userInfo["request_id"] as? String {
                #if DEBUG
                print("[oyobidashi.push] background request=\(id) status=\(userInfo["status"] as? String ?? "unknown")")
                #endif
                // APNs already authenticated this terminal update. Remove the notice
                // before fetching, so deletion also works when the relay is unreachable.
                if let status = userInfo["status"] as? String,
                   ["answered", "cancelled", "expired"].contains(status) {
                    environment.notifications.removeDelivered(requestIDs: [id])
                }
                _ = await environment.model.refreshRequest(id: id)
            } else {
                await environment.model.refresh()
            }
            completionHandler(.newData)
        }
    }

}
