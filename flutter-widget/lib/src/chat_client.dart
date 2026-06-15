import 'dart:convert';
import 'package:http/http.dart' as http;
import 'chat_prefill.dart';

class ChatMessage {
  final String role; // 'user' | 'assistant' | 'system'
  final String content;
  final DateTime ts;
  final String? ticketId;

  const ChatMessage({
    required this.role,
    required this.content,
    required this.ts,
    this.ticketId,
  });
}

class ChatReply {
  final String reply;
  final String? ticketId;
  final bool closed;

  const ChatReply({required this.reply, this.ticketId, this.closed = false});
}

class SpinWiseChatClient {
  final String apiBaseUrl;
  final String? authToken;
  String? _sessionId;

  SpinWiseChatClient({required String apiBaseUrl, this.authToken})
      : apiBaseUrl = apiBaseUrl.replaceAll(RegExp(r'/$'), '');

  String? get sessionId => _sessionId;

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (authToken != null) 'Authorization': 'Bearer $authToken',
      };

  Future<String> startSession({ChatPrefill? prefill}) async {
    final r = await http.post(
      Uri.parse('$apiBaseUrl/chat/session'),
      headers: _headers,
      body: jsonEncode({
        'channel': 'in-app',
        ...?prefill?.toJson(),
      }),
    );
    if (r.statusCode != 201 && r.statusCode != 200) {
      throw Exception('start session failed: ${r.statusCode} ${r.body}');
    }
    final body = jsonDecode(r.body) as Map<String, dynamic>;
    _sessionId = body['sessionId'] as String;
    return _sessionId!;
  }

  Future<ChatReply> send(String message, {List<String>? attachments}) async {
    if (_sessionId == null) await startSession();
    final r = await http.post(
      Uri.parse('$apiBaseUrl/chat/session/$_sessionId/message'),
      headers: _headers,
      body: jsonEncode({
        'message': message,
        if (attachments != null && attachments.isNotEmpty) 'attachments': attachments,
      }),
    );
    if (r.statusCode != 201 && r.statusCode != 200) {
      throw Exception('send failed: ${r.statusCode} ${r.body}');
    }
    final body = jsonDecode(r.body) as Map<String, dynamic>;
    return ChatReply(
      reply: body['reply'] as String? ?? '',
      ticketId: body['ticketId'] as String?,
      closed: body['closed'] as bool? ?? false,
    );
  }
}
