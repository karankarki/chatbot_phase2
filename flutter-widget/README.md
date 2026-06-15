# SpinWise — Flutter Widget

Drop-in Flutter package for the Spin App's *Support* section.

## Integrate

```yaml
# In your Spin App's pubspec.yaml
dependencies:
  spinwise_chat:
    path: ../Spin-ChatBot/flutter-widget
    # or: git: { url: ..., path: flutter-widget }
```

```dart
import 'package:spinwise_chat/spinwise_chat.dart';

// Inside your Support screen:
ListTile(
  leading: const Icon(Icons.chat_bubble_outline),
  title: const Text('Chat with SpinWise'),
  onTap: () => Navigator.push(context, MaterialPageRoute(
    builder: (_) => SpinWiseChatScreen(
      apiBaseUrl: AppConfig.chatbotBaseUrl,    // e.g. https://chatbot-api.exicom-ps.com/api
      authToken: session.idToken,
      prefill: ChatPrefill(
        name: session.user.name,
        mobile: session.user.mobile,
        chargerSerial: selectedCharger?.serial,
        chargerModel: selectedCharger?.model,
      ),
    ),
  )),
)
```

Pre-filling means the bot can skip Stage 2 (mobile lookup) — it still
verifies and dedups via the backend.

## Run the example

```bash
cd example
flutter pub get
flutter run
```

The example uses `http://10.0.2.2:4000/api`, which is the loopback to your
host from an Android emulator. On iOS simulator use `http://localhost:4000/api`.

## What's inside

```
lib/
  spinwise_chat.dart                    # public API barrel
  src/
    chat_prefill.dart                   # ChatPrefill model
    chat_theme.dart                     # SpinWiseTheme colour overrides
    chat_client.dart                    # HTTP client + DTOs
    spinwise_chat_screen.dart           # SpinWiseChatScreen widget
```

## Theming

Override colours via `SpinWiseTheme`:

```dart
SpinWiseChatScreen(
  apiBaseUrl: ...,
  theme: const SpinWiseTheme(
    primary: Color(0xFF0F4D92),
    userBubble: Color(0xFF0F4D92),
    botBubble: Color(0xFFF0F2F8),
  ),
)
```
