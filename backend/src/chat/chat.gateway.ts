import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { ChatService } from './chat.service';
import { Attachment } from './dto';

interface WsMessagePayload {
  sessionId: string;
  message: string;
  attachments?: Attachment[];
}

@WebSocketGateway({
  cors: { origin: true, credentials: true },
  namespace: '/chat',
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly log = new Logger(ChatGateway.name);

  constructor(private readonly chat: ChatService) {}

  handleConnection(socket: Socket) {
    this.log.log(`socket connected: ${socket.id}`);
  }

  handleDisconnect(socket: Socket) {
    this.log.log(`socket disconnected: ${socket.id}`);
  }

  @SubscribeMessage('message')
  async onMessage(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: WsMessagePayload,
  ) {
    try {
      const meta = await this.chat.sendStream(
        body.sessionId,
        body.message,
        (text) => socket.emit('chunk', { text }),
        body.attachments,
      );
      socket.emit('reply', meta);
    } catch (e) {
      socket.emit('error', { message: (e as Error).message });
    }
  }
}
