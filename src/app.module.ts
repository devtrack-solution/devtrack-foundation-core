import { FoundationCoreModule } from './core/infrastructure/modules/foundation-core.module';
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { GeneratedCompositionModule } from './composition/composition.generated';

@Module({
  imports: [FoundationCoreModule, GeneratedCompositionModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
