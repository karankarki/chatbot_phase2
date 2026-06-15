import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ChatModule } from './chat/chat.module';
import { LlmModule } from './llm/llm.module';
import { CrmModule } from './crm/crm.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { SessionModule } from './session/session.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    SessionModule,
    KnowledgeModule,
    CrmModule,
    LlmModule,
    ChatModule,
  ],
})
export class AppModule {}
