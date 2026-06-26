import { Body, Controller, Get, Logger, Param, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { ChatService } from './chat.service';
import { SendMessageDto, StartSessionDto } from './dto';

@Controller('chat')
export class ChatController {
  private readonly log = new Logger(ChatController.name);
  constructor(private readonly chat: ChatService) {}

  @Post('session')
  start(@Body() dto: StartSessionDto, @Req() req: Request) {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0])?.trim() || req.ip || '';
    return this.chat.start(dto, ip);
  }

  @Post('session/:id/message')
  async send(
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const sse = (event: string, data: unknown) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
      const meta = await this.chat.sendStream(
        id,
        dto.message,
        (text) => sse('text', { text }),
        dto.attachments,
      );
      sse('done', meta);
    } catch (e) {
      sse('done', { closed: false, error: (e as Error).message });
    }
    res.end();
  }

  @Post('session/:id/resume')
  resume(@Param('id') id: string) {
    return this.chat.resumeSession(id);
  }

  @Post('session/:id/country')
  updateCountry(@Param('id') id: string, @Body() body: { country: string }) {
    this.chat.updateCountry(id, body.country);
    return { ok: true };
  }

  @Post('session/:id/rating')
  async rating(
    @Param('id') id: string,
    @Body() body: { rating: number; feedback?: string },
  ) {
    await this.chat.saveRating(id, body.rating, body.feedback);
    return { ok: true, showAppRating: body.rating >= 4 };
  }

  // Beacon endpoint — called via navigator.sendBeacon on page close.
  // Returns 204 so the browser beacon succeeds without parsing a body.
  @Post('session/:id/save')
  saveOnClose(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    this.log.log(`[SAVE HIT] curl -X POST http://localhost:4000/api/chat/session/${id}/save -H "Content-Type: application/json" -d '{}'`);
    this.chat.saveOpenChat(id);
    res.status(204).end();
  }

  @Get('session/:id')
  history(@Param('id') id: string) {
    return this.chat.history(id);
  }
}
