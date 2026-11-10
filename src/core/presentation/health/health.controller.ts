import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AdmissionService } from '../http/admission/admission.service';
import { ADMISSION_SERVICE } from '../http/admission/admission.tokens';

/**
 * `live`: processo respondendo. `ready`: apto a receber tráfego; falso durante
 * drenagem ou quando uma dependência obrigatória configurada falha.
 * Registrado somente pelo `AdmissionModule.register`.
 */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(ADMISSION_SERVICE) private readonly admission: AdmissionService,
  ) {}

  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ status: string }> {
    const ready = await this.admission.isReady();
    if (!ready) response.status(503);
    return { status: ready ? 'ready' : 'unavailable' };
  }
}
