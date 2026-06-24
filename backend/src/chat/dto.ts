import { IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class StartSessionDto {
  @IsIn(['web-widget', 'in-app'])
  channel!: 'web-widget' | 'in-app';

  @IsOptional()
  @IsString()
  @MaxLength(60)
  prefillName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  prefillMobile?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  prefillChargerSerial?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  prefillChargerSerials?: string[];

  @IsOptional()
  @IsString()
  @IsIn(['Spin Air', 'Tata/Compact'])
  prefillChargerModel?: 'Spin Air' | 'Tata/Compact';

  @IsOptional()
  prefillChargerModels?: Record<string, 'old' | 'new'>;
}

export interface Attachment {
  /** 'image' | 'pdf' | 'video' */
  type: 'image' | 'pdf' | 'video';
  /** MIME type e.g. image/jpeg, application/pdf, video/mp4 */
  mediaType: string;
  /** base64-encoded file content (no data: prefix) */
  data: string;
  /** original filename */
  name: string;
}

export class SendMessageDto {
  @IsString()
  @MaxLength(2000)
  message!: string;

  @IsOptional()
  @IsArray()
  attachments?: Attachment[];
}
