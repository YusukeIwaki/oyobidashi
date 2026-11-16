import OyobidashiKit
import SwiftUI

@main
struct OyobidashiApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    private let environment = AppEnvironment.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(environment.model)
                .environment(environment.router)
                .environment(environment.callKit)
                .onOpenURL { environment.router.handleDeepLink($0) }
                .task { if scenePhase == .active { environment.model.activate() } }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: environment.model.activate()
            case .background: environment.model.deactivate()
            default: break
            }
        }
    }
}
