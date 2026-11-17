package me.oyobidashi.android.ui

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

private val LightColors = lightColorScheme(
    primary = Color(0xFF0B57D0), onPrimary = Color.White,
    primaryContainer = Color(0xFFD3E3FD), onPrimaryContainer = Color(0xFF041E49),
    secondary = Color(0xFF445E91), secondaryContainer = Color(0xFFD8E2FF),
    onSecondaryContainer = Color(0xFF001B3E),
    background = Color(0xFFF8F9FF), surface = Color(0xFFF8F9FF),
    surfaceContainerLow = Color(0xFFF0F4F9), surfaceContainer = Color(0xFFE9EEF6),
)
private val DarkColors = darkColorScheme(
    primary = Color(0xFFA8C7FA), onPrimary = Color(0xFF062E6F),
    primaryContainer = Color(0xFF0842A0), onPrimaryContainer = Color(0xFFD3E3FD),
    secondary = Color(0xFFADC6FF), secondaryContainer = Color(0xFF2D4672),
    onSecondaryContainer = Color(0xFFD8E2FF),
    background = Color(0xFF111318), surface = Color(0xFF111318),
    surfaceContainerLow = Color(0xFF1D2026), surfaceContainer = Color(0xFF22262D),
)

@Composable
fun OyobidashiTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val context = LocalContext.current
    val colors = when {
        Build.VERSION.SDK_INT >= 31 && dark -> dynamicDarkColorScheme(context)
        Build.VERSION.SDK_INT >= 31 -> dynamicLightColorScheme(context)
        dark -> DarkColors
        else -> LightColors
    }
    MaterialTheme(colorScheme = colors, content = content)
}
