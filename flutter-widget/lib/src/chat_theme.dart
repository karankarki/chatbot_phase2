import 'package:flutter/material.dart';

/// Exicom brand-aligned theme tokens.
///
/// Palette (Brand Identity Guidelines 2.0):
///   Teal     #27BDBE   primary (80%)
///   Neon     #94F440   accent  (20%)
///   Charcoal #343A42   dark surface + body text
///   Gray     #B5B5B5   secondary
///
/// Typography: PP Mori is the brand font (proprietary). Segoe UI Variable is
/// the brand-designated digital fallback. The Flutter `fontFamilyFallback`
/// degrades gracefully on macOS / Android / Linux.
class SpinWiseTheme {
  // Brand
  final Color teal;
  final Color tealDeep;
  final Color tealSoft;
  final Color neon;
  final Color neonDeep;
  final Color charcoal;
  final Color gray;
  final Color graySoft;

  // Semantic
  final Color primary;
  final Color accent;
  final Color userBubble;
  final Color botBubble;
  final Color background;
  final Color surfaceDark;
  final Color textOnDark;
  final Color textPrimary;
  final Color textMuted;
  final Color border;

  // Typography
  final String fontFamily;
  final List<String> fontFamilyFallback;

  const SpinWiseTheme({
    this.teal = const Color(0xFF27BDBE),
    this.tealDeep = const Color(0xFF1FA5A6),
    this.tealSoft = const Color(0xFFE3F8F8),
    this.neon = const Color(0xFF94F440),
    this.neonDeep = const Color(0xFF6FCE21),
    this.charcoal = const Color(0xFF343A42),
    this.gray = const Color(0xFFB5B5B5),
    this.graySoft = const Color(0xFFF4F5F7),
    this.fontFamily = 'PP Mori',
    this.fontFamilyFallback = const [
      'Segoe UI Variable Text',
      'Segoe UI Variable',
      'Segoe UI',
      'Roboto',
      'Helvetica Neue',
      'Arial',
    ],
  })  : primary = teal,
        accent = neon,
        userBubble = charcoal,
        botBubble = graySoft,
        background = const Color(0xFFFFFFFF),
        surfaceDark = charcoal,
        textOnDark = const Color(0xFFFFFFFF),
        textPrimary = charcoal,
        textMuted = const Color(0xFF5B6470),
        border = const Color(0xFFE5E7EB);

  TextStyle textStyle({
    double size = 14.5,
    FontWeight weight = FontWeight.w400,
    Color? color,
    double height = 1.4,
    double letterSpacing = 0,
  }) =>
      TextStyle(
        fontFamily: fontFamily,
        fontFamilyFallback: fontFamilyFallback,
        fontSize: size,
        fontWeight: weight,
        color: color ?? textPrimary,
        height: height,
        letterSpacing: letterSpacing,
      );
}
