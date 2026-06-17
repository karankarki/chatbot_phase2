import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { ChatService } from './chat.service';
import { SendMessageDto, StartSessionDto } from './dto';

@Controller('chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post('session')
  start(@Body() dto: StartSessionDto) {
    return this.chat.start(dto);
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

  @Post('session/:id/rating')
  async rating(
    @Param('id') id: string,
    @Body() body: { rating: number; feedback?: string },
  ) {
    await this.chat.saveRating(id, body.rating, body.feedback);
    return { ok: true };
  }

  // Beacon endpoint — called via navigator.sendBeacon on page close.
  // Returns 204 so the browser beacon succeeds without parsing a body.
  @Post('session/:id/save')
  saveOnClose(@Param('id') id: string, @Res() res: Response) {
    this.chat.saveOpenChat(id);
    res.status(204).end();
  }

  @Get('session/:id')
  history(@Param('id') id: string) {
    return this.chat.history(id);
  }
}
