import AVFoundation
import Speech
import SwiftUI
import UserNotifications

struct PermissionSettingsView: View {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @State private var notifications: UNAuthorizationStatus = .notDetermined
    @State private var speech = SFSpeechRecognizer.authorizationStatus()
    @State private var microphone = AVAudioApplication.shared.recordPermission
    @State private var camera = AVCaptureDevice.authorizationStatus(for: .video)
    @State private var requesting = false

    var body: some View {
        Section {
            permissionRow("通知", status: notificationStatus, needsRequest: notifications == .notDetermined) {
                if notifications == .notDetermined {
                    await AppEnvironment.shared.notifications.requestAuthorization()
                } else {
                    openSettings(UIApplication.openNotificationSettingsURLString)
                }
            }
            permissionRow("マイク", status: microphone == .granted ? "許可済み" : "未許可", needsRequest: microphone == .undetermined) {
                if microphone == .undetermined { _ = await SpeechPermissions.requestMicrophone() }
                else { openSettings() }
            }
            permissionRow("音声認識", status: speech == .authorized ? "許可済み" : "未許可", needsRequest: speech == .notDetermined) {
                if speech == .notDetermined { _ = await SpeechPermissions.requestSpeech() }
                else { openSettings() }
            }
            permissionRow("カメラ（QRコード）", status: camera == .authorized ? "許可済み" : "未許可", needsRequest: camera == .notDetermined) {
                if camera == .notDetermined { _ = await AVCaptureDevice.requestAccess(for: .video) }
                else { openSettings() }
            }
            Button("ローカルネットワークの設定") { openSettings() }
        } header: {
            Text("権限")
        } footer: {
            Text("通知・通話・QRコードに必要な権限を確認できます。Macへ接続できない場合は、ローカルネットワークへのアクセスも確認してください。")
        }
        .task { await refresh() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await refresh() } }
        }
    }

    private var notificationStatus: String {
        switch notifications {
        case .authorized, .provisional, .ephemeral: return "許可済み"
        case .denied: return "未許可"
        case .notDetermined: return "未設定"
        @unknown default: return "確認が必要"
        }
    }

    private func permissionRow(_ title: String, status: String, needsRequest: Bool, action: @escaping @MainActor () async -> Void) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                Text(status).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button(needsRequest ? "許可する" : "設定") {
                Task { @MainActor in
                    requesting = true
                    await action()
                    await refresh()
                    requesting = false
                }
            }
            .buttonStyle(.borderless)
            .disabled(requesting)
            .accessibilityLabel("\(title)の\(needsRequest ? "許可" : "設定")")
        }
    }

    private func openSettings(_ value: String = UIApplication.openSettingsURLString) {
        if let url = URL(string: value) { openURL(url) }
    }

    private func refresh() async {
        notifications = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        speech = SFSpeechRecognizer.authorizationStatus()
        microphone = AVAudioApplication.shared.recordPermission
        camera = AVCaptureDevice.authorizationStatus(for: .video)
    }
}
