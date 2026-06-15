import 'package:flutter/material.dart';
import 'package:spinwise_chat/spinwise_chat.dart';

void main() => runApp(const ExampleApp());

class ExampleApp extends StatelessWidget {
  const ExampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'SpinWise Demo',
      theme: ThemeData(
        useMaterial3: true,
        colorSchemeSeed: const Color(0xFF27BDBE), // Exicom Teal
        // PP Mori is the brand font (proprietary, not bundled here). The
        // chat widget itself applies fontFamilyFallback to Segoe UI Variable
        // (the brand-designated digital fallback) on text it renders.
        fontFamily: 'PP Mori',
      ),
      home: const _SupportHome(),
    );
  }
}

class _SupportHome extends StatelessWidget {
  const _SupportHome();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Spin App — Support')),
      body: ListView(
        children: [
          ListTile(
            leading: const Icon(Icons.chat_bubble_outline, color: Color(0xFF0F4D92)),
            title: const Text('Chat with SpinWise'),
            subtitle: const Text('Quick help for your AC charger or the Spin App.'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.push(
              context,
              MaterialPageRoute(
                builder: (_) => const SpinWiseChatScreen(
                  // Point at your local backend during development.
                  apiBaseUrl: 'http://10.0.2.2:4000/api', // 10.0.2.2 = host machine for Android emulator
                  prefill: ChatPrefill(
                    name: 'Rahul',
                    mobile: '9876543277', // ends in 77 → Tata fixture
                    chargerSerial: 'TC-2025-000123',
                    chargerModel: 'Tata/Compact',
                  ),
                ),
              ),
            ),
          ),
          const ListTile(
            leading: Icon(Icons.book_outlined),
            title: Text('User manual'),
          ),
          const ListTile(
            leading: Icon(Icons.call_outlined),
            title: Text('Call customer care'),
          ),
        ],
      ),
    );
  }
}
