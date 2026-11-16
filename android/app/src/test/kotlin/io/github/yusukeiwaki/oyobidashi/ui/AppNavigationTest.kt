package io.github.yusukeiwaki.oyobidashi.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppNavigationTest {
    @Test fun `home leaves system back to Android`() {
        val navigation = AppNavigation()
        assertFalse(navigation.canGoBack)
        assertEquals(navigation, navigation.back())
    }

    @Test fun `re-pairing returns through settings to home`() {
        var navigation = AppNavigation().openSettings().openPairing()
        assertEquals(Screen.Pairing, navigation.current)
        navigation = navigation.back()
        assertEquals(Screen.Settings, navigation.current)
        assertTrue(navigation.canGoBack)
        navigation = navigation.back()
        assertEquals(Screen.List, navigation.current)
        assertFalse(navigation.canGoBack)
    }

    @Test fun `question notification replaces settings and returns to home`() {
        val navigation = AppNavigation().openSettings().openPairing().openRequest("request-1")
        assertEquals(Screen.Detail("request-1"), navigation.current)
        assertEquals(Screen.List, navigation.back().current)
        assertFalse(navigation.back().canGoBack)
    }

    @Test fun `new notification does not create a question history stack`() {
        val navigation = AppNavigation().openRequest("old").openRequest("new")
        assertEquals(Screen.Detail("new"), navigation.current)
        assertEquals(Screen.List, navigation.back().current)
    }

    @Test fun `reopening settings does not add duplicate back steps`() {
        val navigation = AppNavigation().openSettings().openSettings()
        assertEquals(Screen.List, navigation.back().current)
        assertFalse(navigation.back().canGoBack)
    }
}
