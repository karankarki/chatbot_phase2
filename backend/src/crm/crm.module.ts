import { Module } from '@nestjs/common';
import { CrmClient } from './crm.client';

@Module({
  providers: [CrmClient],
  exports: [CrmClient],
})
export class CrmModule {}
