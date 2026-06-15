import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { LlmModule } from '../llm/llm.module';
import { SessionModule } from '../session/session.module';

@Module({
  imports: [LlmModule, SessionModule],
  controllers: [ChatController],
  providers: [ChatService, ChatGateway],
})
export class ChatModule {}
