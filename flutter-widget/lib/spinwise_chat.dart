/// SpinWise — Exicom AC Charger support chatbot widget.
///
/// Drop into the Support section of the Spin App:
///
/// ```dart
/// SpinWiseChatScreen(
///   apiBaseUrl: 'https://chatbot-api.exicom-ps.com/api',
///   authToken: session.idToken,
///   prefill: ChatPrefill(
///     name: user.name,
///     mobile: user.mobile,
///     chargerSerial: selectedCharger?.serial,
///     chargerModel: selectedCharger?.model,
///   ),
/// )
/// ```
library spinwise_chat;

export 'src/spinwise_chat_screen.dart';
export 'src/chat_prefill.dart';
export 'src/chat_theme.dart';
