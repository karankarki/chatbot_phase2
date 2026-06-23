import { Controller, Get, Req } from '@nestjs/common';
import { Request } from 'express';
import * as geoip from 'geoip-lite';

@Controller('geo')
export class GeoController {
  @Get()
  getCountry(@Req() req: Request): { country: string } {
    const forwarded = req.headers['x-forwarded-for'] as string | undefined;
    const raw = forwarded
      ? forwarded.split(',')[0].trim()
      : (req.socket?.remoteAddress ?? '');
    const ip = raw.replace(/^::ffff:/, '');
    const geo = geoip.lookup(ip);
    return { country: geo?.country ?? 'IN' };
  }
}
