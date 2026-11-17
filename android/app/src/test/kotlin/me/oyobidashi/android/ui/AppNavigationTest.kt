package me.oyobidashi.android.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppNavigationTest {
    @Test fun `answer confirmation returns to pending list without retaining answered detail`() {
        val confirmation = AppNavigation().openRequest("request-1").answerSubmitted("request-1")
        assertEquals(Screen.AnswerSent("request-1"), confirmation.current)
        val finished = confirmation.finishAnswerCompletion("request-1")
        assertEquals(Screen.List, finished.current)
        assertFalse(finished.canGoBack)
        assertEquals(Screen.List, confirmation.back().current)
    }

    @Test fun `late answer and completion cannot dismiss a newer question or settings`() {
        val newer = AppNavigation().openRequest("old").openRequest("new")
        assertEquals(newer, newer.answerSubmitted("old"))
        val interrupted = AppNavigation().openRequest("old").answerSubmitted("old").openRequest("new")
        assertEquals(interrupted, interrupted.finishAnswerCompletion("old"))
        val settings = AppNavigation().openSettings()
        assertEquals(settings, settings.answerSubmitted("old"))
    }

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
