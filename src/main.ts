// Inicialização antecipada: este import deve ser a PRIMEIRA linha. Carrega a
// instrumentação OTel (vazia quando não selecionada) antes de http, express e Nest.
import './composition/instrumentation.generated';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Necessário para drenagem (admissão) e encerramento ordenado dos adapters.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
