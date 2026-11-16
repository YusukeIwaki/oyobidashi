import AVFoundation
import Speech
import SwiftUI

/// Ask while the app is foregrounded, before a locked-screen CallKit answer needs the microphone.
struct VoicePermissionsView: View {
    var hidesWhenReady = false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @State private var speech = SFSpeechRecognizer.authorizationStatus()
    @State private var microphone = AVAudioApplication.shared.recordPermission
    @State private var requesting = false

    private var ready: Bool { speech == .authorized && microphone == .granted }
    private var denied: Bool { speech == .denied || speech == .restricted || microphone == .denied }

    var body: some View {
        Group {
          if !hidesWhenReady || !ready {
            VStack(alignment: .leading, spacing: 10) {
                Label(ready ? "音声通話の準備ができました" : "音声通話を準備", systemImage: ready ? "checkmark.circle" : "phone.badge.waveform")
                    .font(.headline)
                Text(ready ? "着信に応答すると、音声で回答できます。" : "着信に応答してすぐ話せるよう、マイクと音声認識を許可してください。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                if !ready {
                    Button(denied ? "設定アプリを開く" : "マイク・音声認識を許可") {
                        if denied {
                            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                        } else {
                            Task { @MainActor in
                                requesting = true
                                _ = await SpeechPermissions.requestSpeech()
                                _ = await SpeechPermissions.requestMicrophone()
                                refresh()
                                requesting = false
                            }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(PagerTheme.orange)
                    .disabled(requesting)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(hidesWhenReady ? 16 : 0)
            .background(hidesWhenReady ? PagerTheme.card : .clear, in: RoundedRectangle(cornerRadius: 14))
          }
        }
        .onAppear { refresh() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { refresh() } }
    }

    private func refresh() {
        speech = SFSpeechRecognizer.authorizationStatus()
        microphone = AVAudioApplication.shared.recordPermission
    }
}
