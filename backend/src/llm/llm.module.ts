import { Module } from '@nestjs/common';
import { LlmService } from './llm.service';
import { ToolRegistry } from './tools.registry';
import { CrmModule } from '../crm/crm.module';
import { SessionModule } from '../session/session.module';

@Module({
  imports: [CrmModule, SessionModule],
  providers: [LlmService, ToolRegistry],
  exports: [LlmService],
})
export class LlmModule {}
