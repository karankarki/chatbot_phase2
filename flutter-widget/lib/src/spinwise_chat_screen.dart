import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'chat_client.dart';
import 'chat_prefill.dart';
import 'chat_theme.dart';

class SpinWiseChatScreen extends StatefulWidget {
  final String apiBaseUrl;
  final String? authToken;
  final ChatPrefill? prefill;
  final SpinWiseTheme theme;

  const SpinWiseChatScreen({
    super.key,
    required this.apiBaseUrl,
    this.authToken,
    this.prefill,
    this.theme = const SpinWiseTheme(),
  });

  @override
  State<SpinWiseChatScreen> createState() => _SpinWiseChatScreenState();
}

class _Bubble {
  final String role; // user | bot | system | ticket
  final String text;
  final String? ticketId;
  final List<String>? quickReplies;
  const _Bubble({
    required this.role,
    required this.text,
    this.ticketId,
    this.quickReplies,
  });
}

/// Exicom wordmark — the brand-book "Company Logo" (`exicom` in lowercase
/// PP Mori, with the brand-designated Segoe UI Variable fallback). Pure
/// text so it renders sharply at any DPI and inherits color for the
/// Reverse-on-Dark variant.
class _ExicomWordmark extends StatelessWidget {
  final double size;
  final Color color;
  const _ExicomWordmark({required this.size, required this.color});

  @override
  Widget build(BuildContext context) {
    return Text(
      'exicom',
      style: TextStyle(
        fontFamily: 'PP Mori',
        fontFamilyFallback: const [
          'Segoe UI Variable Display',
          'Segoe UI Variable',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
        ],
        fontSize: size,
        fontWeight: FontWeight.w600,
        color: color,
        letterSpacing: -size * 0.04,
        height: 1.0,
      ),
    );
  }
}

class _SpinWiseChatScreenState extends State<SpinWiseChatScreen> {
  late final SpinWiseChatClient _client;
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final _picker = ImagePicker();

  final List<_Bubble> _bubbles = [];
  List<String> _pendingAttachments = [];
  bool _sending = false;
  bool _booting = true;

  @override
  void initState() {
    super.initState();
    _client = SpinWiseChatClient(
      apiBaseUrl: widget.apiBaseUrl,
      authToken: widget.authToken,
    );
    _start();
  }

  Future<void> _start() async {
    try {
      await _client.startSession(prefill: widget.prefill);
      await _send('Hi', userVisible: false);
    } catch (e) {
      setState(() {
        _bubbles.add(_Bubble(
          role: 'system',
          text: "Couldn't reach SpinWise: $e",
        ));
      });
    } finally {
      setState(() => _booting = false);
    }
  }

  Future<void> _send(String text, {bool userVisible = true}) async {
    if (text.trim().isEmpty || _sending) return;
    setState(() {
      if (userVisible) {
        _bubbles.add(_Bubble(role: 'user', text: text));
      }
      _sending = true;
    });
    _scrollToBottom();
    try {
      final res = await _client.send(text, attachments: _pendingAttachments);
      _pendingAttachments = [];
      setState(() {
        _bubbles.add(_Bubble(
          role: 'bot',
          text: res.reply,
          quickReplies: _suggestedQuickReplies(res.reply),
          ticketId: res.ticketId,
        ));
        if (res.ticketId != null) {
          _bubbles.add(_Bubble(role: 'ticket', text: '', ticketId: res.ticketId));
        }
      });
    } catch (e) {
      setState(() => _bubbles.add(_Bubble(role: 'system', text: 'Network error: $e')));
    } finally {
      setState(() => _sending = false);
      _scrollToBottom();
    }
  }

  List<String>? _suggestedQuickReplies(String reply) {
    if (RegExp(r'is your issue with the (charger|spin app)', caseSensitive: false).hasMatch(reply)) {
      return ['Charger problem', 'Spin App help', 'RFID card', 'Status of a complaint', 'Something else'];
    }
    if (RegExp(r'colou?r.*led|what.*colou?r.*charger', caseSensitive: false).hasMatch(reply)) {
      return ['Red — steady', 'Red — blinking slow', 'Red — blinking fast', 'Yellow', 'Green blinking', 'No light'];
    }
    return null;
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOut,
        );
      }
    });
  }

  Future<void> _pickPhoto() async {
    final file = await _picker.pickImage(source: ImageSource.gallery, maxWidth: 1600);
    if (file == null) return;
    setState(() {
      _pendingAttachments = [..._pendingAttachments, file.name];
      _bubbles.add(_Bubble(
          role: 'system',
          text: '📎 ${file.name} attached — will be sent with your next message.'));
    });
    _scrollToBottom();
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.theme;
    return Scaffold(
      backgroundColor: t.background,
      appBar: PreferredSize(
        preferredSize: const Size.fromHeight(64),
        child: AppBar(
          backgroundColor: t.charcoal,
          foregroundColor: t.textOnDark,
          elevation: 0,
          systemOverlayStyle: SystemUiOverlayStyle.light,
          titleSpacing: 12,
          title: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Row(
                children: [
                  Container(
                    width: 8,
                    height: 8,
                    decoration: BoxDecoration(
                      color: t.neon,
                      shape: BoxShape.circle,
                      boxShadow: [
                        BoxShadow(color: t.neon.withOpacity(0.35), blurRadius: 6),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    'SpinWise',
                    style: t.textStyle(
                      size: 16,
                      weight: FontWeight.w600,
                      color: t.textOnDark,
                      letterSpacing: -0.01,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 3),
              // Exicom wordmark (Reverse on Dark) below the product name per
              // the brand book's product/mother-brand pairing rule.
              Row(
                children: [
                  _ExicomWordmark(size: 13, color: t.textOnDark.withOpacity(0.78)),
                  Text(
                    ' · virtual assistant',
                    style: t.textStyle(
                      size: 12,
                      color: t.textOnDark.withOpacity(0.72),
                      letterSpacing: 0.01,
                    ),
                  ),
                ],
              ),
            ],
          ),
          actions: [
            IconButton(
              tooltip: 'Restart conversation',
              icon: const Icon(Icons.refresh),
              onPressed: _booting
                  ? null
                  : () {
                      setState(() {
                        _bubbles.clear();
                        _booting = true;
                      });
                      _start();
                    },
            ),
          ],
          flexibleSpace: Align(
            alignment: Alignment.bottomCenter,
            child: Container(
              height: 2,
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  colors: [t.teal, t.neon],
                  stops: const [0.8, 1.0],
                ),
              ),
            ),
          ),
        ),
      ),
      body: Column(
        children: [
          Expanded(
            child: _booting
                ? Center(
                    child: CircularProgressIndicator(color: t.teal, strokeWidth: 2.5),
                  )
                : ListView.builder(
                    controller: _scroll,
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
                    itemCount: _bubbles.length + (_sending ? 1 : 0),
                    itemBuilder: (ctx, i) {
                      if (_sending && i == _bubbles.length) return _TypingDots(theme: t);
                      return _BubbleView(
                        bubble: _bubbles[i],
                        theme: t,
                        onQuickReply: _send,
                      );
                    },
                  ),
          ),
          _Composer(
            controller: _input,
            theme: t,
            enabled: !_sending && !_booting,
            attachments: _pendingAttachments.length,
            onAttach: _pickPhoto,
            onSend: () {
              final text = _input.text.trim();
              if (text.isEmpty) return;
              _input.clear();
              _send(text);
            },
          ),
        ],
      ),
    );
  }
}

class _BubbleView extends StatelessWidget {
  final _Bubble bubble;
  final SpinWiseTheme theme;
  final void Function(String) onQuickReply;

  const _BubbleView({required this.bubble, required this.theme, required this.onQuickReply});

  @override
  Widget build(BuildContext context) {
    if (bubble.role == 'ticket' && bubble.ticketId != null) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(
            gradient: const LinearGradient(
              colors: [Color(0xFFEAFCDA), Color(0xFFD9F8C0)],
            ),
            border: Border(left: BorderSide(color: theme.neonDeep, width: 4)),
            borderRadius: BorderRadius.circular(12),
          ),
          child: RichText(
            text: TextSpan(
              style: theme.textStyle(size: 13.5, color: theme.charcoal),
              children: [
                const TextSpan(text: 'Ticket raised: '),
                TextSpan(
                  text: bubble.ticketId,
                  style: theme.textStyle(
                    size: 13.5,
                    weight: FontWeight.w700,
                    color: theme.neonDeep,
                  ),
                ),
                const TextSpan(text: '. You will receive an SMS confirmation.'),
              ],
            ),
          ),
        ),
      );
    }

    if (bubble.role == 'system') {
      return Center(
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 6),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          decoration: BoxDecoration(
            color: theme.tealSoft,
            borderRadius: BorderRadius.circular(10),
          ),
          child: Text(
            bubble.text,
            style: theme.textStyle(size: 12, color: theme.textMuted),
          ),
        ),
      );
    }

    final isUser = bubble.role == 'user';
    return Column(
      crossAxisAlignment: isUser ? CrossAxisAlignment.end : CrossAxisAlignment.start,
      children: [
        ConstrainedBox(
          constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.78),
          child: Container(
            margin: const EdgeInsets.symmetric(vertical: 4),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: isUser ? theme.userBubble : theme.botBubble,
              border: isUser ? null : Border.all(color: theme.border),
              borderRadius: BorderRadius.only(
                topLeft: const Radius.circular(16),
                topRight: const Radius.circular(16),
                bottomLeft: Radius.circular(isUser ? 16 : 4),
                bottomRight: Radius.circular(isUser ? 4 : 16),
              ),
            ),
            child: Text(
              bubble.text,
              style: theme.textStyle(
                size: 14.5,
                height: 1.5,
                color: isUser ? theme.textOnDark : theme.textPrimary,
              ),
            ),
          ),
        ),
        if (bubble.quickReplies != null)
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: bubble.quickReplies!
                .map((q) => OutlinedButton(
                      onPressed: () => onQuickReply(q),
                      style: OutlinedButton.styleFrom(
                        side: BorderSide(color: theme.teal, width: 1.5),
                        foregroundColor: theme.tealDeep,
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
                        shape: const StadiumBorder(),
                      ),
                      child: Text(
                        q,
                        style: theme.textStyle(
                          size: 13,
                          weight: FontWeight.w500,
                          color: theme.tealDeep,
                        ),
                      ),
                    ))
                .toList(),
          ),
      ],
    );
  }
}

class _TypingDots extends StatefulWidget {
  final SpinWiseTheme theme;
  const _TypingDots({required this.theme});
  @override
  State<_TypingDots> createState() => _TypingDotsState();
}

class _TypingDotsState extends State<_TypingDots> with SingleTickerProviderStateMixin {
  late final AnimationController _c =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 1200))..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(left: 8, top: 8),
      child: AnimatedBuilder(
        animation: _c,
        builder: (_, __) {
          return Row(
            mainAxisSize: MainAxisSize.min,
            children: List.generate(3, (i) {
              final phase = ((_c.value * 3) - i).clamp(0.0, 1.0);
              return Container(
                margin: const EdgeInsets.only(right: 4),
                width: 6,
                height: 6,
                decoration: BoxDecoration(
                  color: widget.theme.teal.withOpacity(0.3 + 0.7 * (1 - phase).abs()),
                  shape: BoxShape.circle,
                ),
              );
            }),
          );
        },
      ),
    );
  }
}

class _Composer extends StatelessWidget {
  final TextEditingController controller;
  final SpinWiseTheme theme;
  final bool enabled;
  final int attachments;
  final VoidCallback onSend;
  final VoidCallback onAttach;

  const _Composer({
    required this.controller,
    required this.theme,
    required this.enabled,
    required this.attachments,
    required this.onSend,
    required this.onAttach,
  });

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
        decoration: BoxDecoration(
          color: theme.background,
          border: Border(top: BorderSide(color: theme.border)),
        ),
        child: Row(
          children: [
            IconButton(
              icon: Stack(
                children: [
                  Icon(Icons.attach_file_outlined, color: theme.textMuted),
                  if (attachments > 0)
                    Positioned(
                      right: -2,
                      top: -2,
                      child: Container(
                        padding: const EdgeInsets.all(3),
                        decoration: BoxDecoration(color: theme.teal, shape: BoxShape.circle),
                        child: Text('$attachments',
                            style: theme.textStyle(
                              size: 9,
                              color: theme.textOnDark,
                              weight: FontWeight.w600,
                            )),
                      ),
                    ),
                ],
              ),
              onPressed: enabled ? onAttach : null,
              tooltip: 'Attach a photo',
            ),
            Expanded(
              child: TextField(
                controller: controller,
                enabled: enabled,
                minLines: 1,
                maxLines: 4,
                textInputAction: TextInputAction.send,
                style: theme.textStyle(size: 14.5),
                onSubmitted: (_) => onSend(),
                decoration: InputDecoration(
                  hintText: 'Type your message…',
                  hintStyle: theme.textStyle(size: 14.5, color: theme.textMuted),
                  filled: true,
                  fillColor: theme.graySoft,
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(20),
                    borderSide: BorderSide.none,
                  ),
                  focusedBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(20),
                    borderSide: BorderSide(color: theme.teal, width: 1.5),
                  ),
                  enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(20),
                    borderSide: BorderSide.none,
                  ),
                  contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                ),
              ),
            ),
            const SizedBox(width: 6),
            Material(
              color: enabled ? theme.teal : theme.teal.withOpacity(0.4),
              borderRadius: BorderRadius.circular(20),
              child: InkWell(
                borderRadius: BorderRadius.circular(20),
                onTap: enabled ? onSend : null,
                child: Padding(
                  padding: const EdgeInsets.all(10),
                  child: Icon(Icons.send_rounded, color: theme.textOnDark),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
