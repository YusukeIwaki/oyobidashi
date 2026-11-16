package io.github.yusukeiwaki.oyobidashi.ui

sealed interface Screen {
    data object List : Screen
    data class Detail(val requestId: String) : Screen
    data object Settings : Screen
    data object Pairing : Screen
}

/** Notifications open a question above Home, without retaining unrelated settings or old questions. */
@ConsistentCopyVisibility
data class AppNavigation private constructor(private val backStack: List<Screen>) {
    constructor() : this(listOf(Screen.List))

    val current: Screen get() = backStack.last()
    val canGoBack: Boolean get() = backStack.size > 1

    fun openSettings() = AppNavigation(listOf(Screen.List, Screen.Settings))
    fun openPairing() = AppNavigation(listOf(Screen.List, Screen.Settings, Screen.Pairing))
    fun openRequest(id: String) = AppNavigation(listOf(Screen.List, Screen.Detail(id)))
    fun back() = if (canGoBack) AppNavigation(backStack.dropLast(1)) else this
}
