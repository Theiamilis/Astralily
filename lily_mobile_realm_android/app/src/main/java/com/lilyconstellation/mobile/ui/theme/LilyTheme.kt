package com.lilyconstellation.mobile.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

private val LilyLightScheme = lightColorScheme(
    primary = Color(0xFFC43C7D),
    onPrimary = Color.White,
    secondary = Color(0xFF7654A5),
    onSecondary = Color.White,
    tertiary = Color(0xFFF092BD),
    background = Color(0xFFFFF8FC),
    surface = Color(0xFFFFFDFD),
    onSurface = Color(0xFF412F3B),
    outline = Color(0xFFE9CDDD),
    surfaceVariant = Color(0xFFF5E9F1),
)

private val LilyDarkScheme = darkColorScheme(
    primary = Color(0xFFF05A9D),
    onPrimary = Color(0xFF281A25),
    secondary = Color(0xFFB896D5),
    onSecondary = Color(0xFF281A25),
    tertiary = Color(0xFFDABDEB),
    background = Color(0xFF251A24),
    surface = Color(0xFF342635),
    onSurface = Color(0xFFF6EAF1),
    outline = Color(0xFF674A61),
    surfaceVariant = Color(0xFF493449),
)

private val LilyTypography = Typography(
    titleLarge = Typography().titleLarge.copy(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = Typography().titleMedium.copy(fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = Typography().bodyLarge.copy(fontSize = 16.sp, lineHeight = 23.sp),
    bodyMedium = Typography().bodyMedium.copy(fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = Typography().bodySmall.copy(fontSize = 12.sp, lineHeight = 17.sp),
    labelLarge = Typography().labelLarge.copy(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
)

@Composable
fun LilyTheme(darkTheme: Boolean = false, content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (darkTheme) LilyDarkScheme else LilyLightScheme,
        typography = LilyTypography,
        content = content,
    )
}
